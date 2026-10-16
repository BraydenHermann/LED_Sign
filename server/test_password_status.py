"""Offline checks for the sign-reported passcode status handshake."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import main


class PasswordPacketTests(unittest.TestCase):
    def test_device_info_password_uses_get_request(self):
        packet = main.protocol.device_info_all_command("123456")
        self.assertEqual(packet[8:10], b"\xc1\x03")
        self.assertEqual(packet[10:18], b"\x0a\x06" + b"123456")
        self.assertEqual(packet[18:-2], b"\x1b\x00\x04\x00\x06\x00")


class PasswordStatusTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        for name, value in {
            "notification_buffer": bytearray(),
            "password_enabled": None,
            "password_command_lock": asyncio.Lock(),
            "_auth_reply_waiter": None,
            "_auth_reply_sno": None,
        }.items():
            patcher = patch.object(main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    async def test_complete_frame_is_required(self):
        response = main.protocol.build_packet(b"\x37\x01\x03", sno=123, cmd_type=0x81, sub_type=0x83)
        future = asyncio.get_running_loop().create_future()
        main._auth_reply_waiter = future
        main._auth_reply_sno = 123
        main.notification_handler(None, response[:-2])
        self.assertFalse(future.done())
        main.notification_handler(None, response[-2:])
        self.assertTrue(future.result()["password_enabled"])
        self.assertTrue(main.password_enabled)

    async def test_read_password_state_uses_sign_reply(self):
        async def reply(_uuid, packet, response=True):
            sno = int.from_bytes(packet[6:8], "little")
            result = main.protocol.build_packet(b"\x37\x01\x02", sno=sno, cmd_type=0x81, sub_type=0x83)
            main.notification_handler(None, result)

        with patch.object(main, "safe_write_gatt_char", side_effect=reply):
            self.assertIs(await main._read_sign_password_state(), False)
            self.assertIs(main.password_enabled, False)

    async def test_settings_reuses_connection_password_state(self):
        class ConnectedClient:
            is_connected = True

        with patch.object(main, "connected_client", ConnectedClient()), \
             patch.object(main, "connection_ready", True), \
             patch.object(main, "password_enabled", True), \
             patch.object(main, "_read_sign_password_state", new_callable=AsyncMock) as read_status:
            self.assertEqual(await main.get_sign_password(), {"enabled": True})
            read_status.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
