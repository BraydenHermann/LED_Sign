"""Tests for session passcode caching and automatic reconnect handling."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch, MagicMock

import main
from main import ConnectRequest, PasscodeRequiredError, SignPasswordRequest


class MockChar:
    uuid = main.protocol.WRITE_UUID


class MockService:
    characteristics = [MockChar()]


def make_mock_client(mac):
    mock = AsyncMock()
    mock.is_connected = True
    mock.address = mac
    mock.services = [MockService()]
    mock.connect = AsyncMock(return_value=None)
    mock.disconnect = AsyncMock(return_value=None)
    mock.start_notify = AsyncMock(return_value=None)
    mock.stop_notify = AsyncMock(return_value=None)
    return mock


class MockScanner:
    def __init__(self, detection_callback=None, **kwargs):
        self.cb = detection_callback

    async def start(self):
        if self.cb:
            dev = MagicMock()
            dev.address = "FF:24:10:29:11:22"
            dev.name = "LOY-SIGN"
            adv = MagicMock()
            adv.rssi = -50
            adv.local_name = "LOY-SIGN"
            self.cb(dev, adv)

    async def stop(self):
        pass


class SessionPasscodeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        main._session_passcodes.clear()
        main.last_connected_mac = ""
        main._suppress_auto_reconnect = False
        main.connected_client = None

    def tearDown(self):
        main._session_passcodes.clear()
        main.last_connected_mac = ""
        main._suppress_auto_reconnect = False
        main.connected_client = None

    async def test_session_passcode_saved_on_connection(self):
        mac = "FF:24:10:29:11:22"
        mock_client = make_mock_client(mac)

        with patch.object(main, "BleakScanner", MockScanner), \
             patch.object(main, "BleakClient", return_value=mock_client), \
             patch.object(main, "_password_request", new_callable=AsyncMock) as mock_pw_req, \
             patch.object(main, "_read_sign_password_state", new_callable=AsyncMock) as mock_pw_state, \
             patch.object(main, "safe_write_gatt_char", new_callable=AsyncMock), \
             patch.object(main, "stop_all_playback", new_callable=AsyncMock):
            mock_pw_req.return_value = {"ok": True, "error_code": 0}
            mock_pw_state.return_value = True

            req = ConnectRequest(address=mac, passcode="654321")
            result = await main._connect_internal(req)
            self.assertEqual(result["status"], "success")
            self.assertEqual(main._session_passcodes.get(mac), "654321")

    async def test_connect_uses_cached_session_passcode_when_omitted(self):
        mac = "FF:24:10:29:11:22"
        main._session_passcodes[mac] = "123456"

        mock_client = make_mock_client(mac)

        with patch.object(main, "BleakScanner", MockScanner), \
             patch.object(main, "BleakClient", return_value=mock_client), \
             patch.object(main, "_password_request", new_callable=AsyncMock) as mock_pw_req, \
             patch.object(main, "_read_sign_password_state", new_callable=AsyncMock) as mock_pw_state, \
             patch.object(main, "safe_write_gatt_char", new_callable=AsyncMock), \
             patch.object(main, "stop_all_playback", new_callable=AsyncMock):
            mock_pw_req.return_value = {"ok": True, "error_code": 0}
            mock_pw_state.return_value = True

            # Request sent without passcode; should use cached passcode
            req = ConnectRequest(address=mac)
            result = await main._connect_internal(req)
            self.assertEqual(result["status"], "success")
            mock_pw_req.assert_awaited()
            call_packet = mock_pw_req.call_args[0][0]
            self.assertIn(b"123456", call_packet)

    async def test_invalid_passcode_clears_session_cache(self):
        mac = "FF:24:10:29:11:22"
        main._session_passcodes[mac] = "999999"
        main.last_connected_mac = mac

        mock_client = make_mock_client(mac)

        with patch.object(main, "BleakScanner", MockScanner), \
             patch.object(main, "BleakClient", return_value=mock_client), \
             patch.object(main, "_password_request", new_callable=AsyncMock) as mock_pw_req, \
             patch.object(main, "safe_write_gatt_char", new_callable=AsyncMock):
            # Error 13 = invalid passcode
            mock_pw_req.return_value = {"ok": False, "error_code": 13}

            req = ConnectRequest(address=mac, passcode="999999")
            with self.assertRaises(main.HTTPException) as ctx:
                await main._connect_internal(req)
            self.assertEqual(ctx.exception.status_code, 401)
            self.assertEqual(ctx.exception.detail["code"], "invalid_passcode")
            # Should have evicted invalid passcode
            self.assertNotIn(mac, main._session_passcodes)

    async def test_auto_reconnect_supplies_cached_passcode(self):
        mac = "FF:24:10:29:11:22"
        main._session_passcodes[mac] = "112233"

        with patch.object(main, "_connect_internal", new_callable=AsyncMock) as mock_connect:
            mock_connect.return_value = {"status": "success"}
            await main._auto_reconnect(mac, delay=0.01)
            mock_connect.assert_awaited_once()
            called_req = mock_connect.call_args[0][0]
            self.assertEqual(called_req.address, mac)
            self.assertEqual(called_req.passcode, "112233")

    async def test_set_sign_password_updates_and_clears_cache(self):
        mac = "FF:24:10:29:11:22"
        mock_client = make_mock_client(mac)

        with patch.object(main, "connected_client", mock_client), \
             patch.object(main, "connection_ready", True), \
             patch.object(main, "connected_device_id", "DEV123"), \
             patch.object(main, "_password_request", new_callable=AsyncMock) as mock_pw_req, \
             patch.object(main, "_read_sign_password_state", new_callable=AsyncMock) as mock_pw_state, \
             patch.object(main, "_loy_recovery_request", return_value={"code": 200}):
            # Set new password
            mock_pw_req.return_value = {"ok": True, "error_code": 0}
            mock_pw_state.return_value = True

            await main.set_sign_password(SignPasswordRequest(enabled=True, passcode="654321", recovery_contact="test@example.com"))
            self.assertEqual(main._session_passcodes.get(mac), "654321")

            # Disable password
            mock_pw_state.return_value = False
            await main.set_sign_password(SignPasswordRequest(enabled=False))
            self.assertNotIn(mac, main._session_passcodes)

    async def test_disconnect_clears_session_cache_and_disconnects_client(self):
        mac = "FF:24:10:29:11:22"
        main._session_passcodes[mac] = "123456"
        mock_client = make_mock_client(mac)
        main.connected_client = mock_client
        main.connection_ready = True

        res = await main.disconnect()
        self.assertEqual(res, {"status": "success"})
        self.assertEqual(len(main._session_passcodes), 0)
        self.assertFalse(main.connection_ready)
        self.assertIsNone(main.connected_client)
        mock_client.disconnect.assert_awaited()


if __name__ == "__main__":
    unittest.main()
