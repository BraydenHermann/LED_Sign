"""Offline regression checks: no Bluetooth device or calendar requests."""
import asyncio
import base64
import io
import json
import struct
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from PIL import Image
import main


class FakeSign:
    address = "AA:BB:CC:DD:EE:FF"
    is_connected = True
    _backend = object()
    mtu_size = 247

    def __init__(self, fail_at=None, reject_sno=None, silent=False):
        self.writes = []
        self.fail_at = fail_at
        self.reject_sno = reject_sno
        self.silent = silent
        self.pending = bytearray()

    async def write_gatt_char(self, uuid, data, response=True):
        self.writes.append(bytes(data))
        if len(self.writes) == self.fail_at:
            raise OSError("Simulated Bluetooth write failure")
        # Reassemble fragments and acknowledge each complete packet the way
        # the sign does: a status reply echoing the SNO, tag 0 for success.
        self.pending.extend(data)
        while len(self.pending) >= 6 and self.pending[:2] == b"\xaa\x55":
            total = struct.unpack("<H", self.pending[4:6])[0] + 6
            if len(self.pending) < total:
                break
            sno = bytes(self.pending[6:8])
            del self.pending[:total]
            if not self.silent:
                code = 7 if struct.unpack("<H", sno)[0] == self.reject_sno else 0
                main.notification_handler(None, bytearray(b"\xaa\x55\xff\xff\x07\x00" + sno + bytes([0x81, 0x82, code, 0, 0])))


class PresetRegressionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        for name, value in {
            "STATIC_DIR": self.directory.name,
            "connected_client": FakeSign(),
            "connection_ready": True,
            "active_scroller_task": None,
            "preset_switch_lock": asyncio.Lock(),
            "ble_lock": asyncio.Lock(),
            "notification_buffer": bytearray(),
            "SLOT_ACK_TIMEOUT": 0.05,
        }.items():
            patcher = patch.object(main, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def request(self, compact=False):
        # Two frames with different top/bottom rows detect accidental
        # contiguous-frame decoding of row-stitched video data.
        frames = [
            ["#ff0000"] * 640 + ["#00ff00"] * 640,
            ["#0000ff"] * 640 + ["#ffffff"] * 640,
        ]
        pixels = [p for row in range(20) for frame in frames for p in frame[row * 64:(row + 1) * 64]]
        preset = dict(mode="image", fileType="video", pixels=pixels, frameDurationMs=50)
        if compact:
            preset["pixelsRgbB64"] = base64.b64encode(b"".join(bytes.fromhex(p[1:]) for p in pixels)).decode()
            preset["pixels"] = None
        return main.SavePresetRequest(slot_id=8, address=FakeSign.address, preset=main.PushTextRequest(**preset), progress_id="test")

    async def test_video_rows_frames_and_preview_survive_slot_save(self):
        for compact in (False, True):
            with patch.object(main.asyncio, "sleep", new=AsyncMock()):
                result = await main.save_preset(self.request(compact))
            self.assertTrue(result["written_to_sign"])
            gif = Image.open(Path(self.directory.name) / "current.gif")
            self.assertEqual(gif.n_frames, 2)
            self.assertEqual(gif.convert("RGB").getpixel((0, 0)), (255, 0, 0))
            self.assertEqual(gif.convert("RGB").getpixel((0, 19)), (0, 255, 0))
            gif.seek(1)
            self.assertEqual(gif.convert("RGB").getpixel((0, 0)), (0, 0, 255))
            self.assertEqual(gif.info["duration"], 50)
            gif.close()
            cached = json.loads((Path(self.directory.name) / "preset_aabbccddeeff_8.json").read_text())
            self.assertEqual(len(cached["pixels"]), 2560)

    async def test_failed_write_preserves_cache_and_reports_failure(self):
        previous = Path(self.directory.name) / "preset_aabbccddeeff_8.gif"
        previous.write_bytes(b"last good preset")
        main.connected_client = FakeSign(fail_at=6)
        with patch.object(main.asyncio, "sleep", new=AsyncMock()):
            with self.assertRaises(HTTPException):
                await main.save_preset(self.request())
        self.assertEqual(previous.read_bytes(), b"last good preset")
        self.assertFalse((Path(self.directory.name) / "current.gif").exists())

    async def test_save_and_play_cannot_interleave(self):
        order = []
        async def save(req):
            order.append("save start")
            await asyncio.sleep(0.01)
            order.append("save end")
        async def play(slot, mac):
            order.append("play")
        with patch.object(main, "_save_preset", save), patch.object(main, "_play_preset", play):
            await asyncio.gather(main.save_preset(self.request()), main.play_preset(0))
        self.assertEqual(order, ["save start", "save end", "play"])

    async def test_disconnected_write_is_not_success(self):
        main.connected_client = None
        with self.assertRaises(HTTPException) as error:
            await main.save_preset(self.request())
        self.assertEqual(error.exception.status_code, 409)

    async def test_save_refuses_a_different_connected_sign(self):
        request = self.request()
        request.address = "11:22:33:44:55:66"
        with self.assertRaises(HTTPException) as error:
            await main.save_preset(request)
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(main.connected_client.writes, [])
        self.assertFalse(list(Path(self.directory.name).glob("preset_*.json")))

    async def test_queued_save_refuses_sign_that_changed_while_waiting(self):
        await main.preset_switch_lock.acquire()
        task = asyncio.create_task(main.save_preset(self.request()))
        await asyncio.sleep(0)
        changed_sign = FakeSign()
        changed_sign.address = "11:22:33:44:55:66"
        main.connected_client = changed_sign
        main.preset_switch_lock.release()
        with self.assertRaises(HTTPException) as error:
            await task
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(changed_sign.writes, [])

    async def test_play_refuses_a_different_connected_sign(self):
        with self.assertRaises(HTTPException) as error:
            await main.play_preset(8, mac="11:22:33:44:55:66")
        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(main.connected_client.writes, [])

    async def test_save_can_be_cancelled(self):
        fake_sign = FakeSign()
        main.connected_client = fake_sign
        req = self.request()
        req.progress_id = "test-cancel-prog"

        async def cancel_on_sleep(*args, **kwargs):
            if len(fake_sign.writes) >= 2:
                await main.cancel_save_preset_by_id("test-cancel-prog")

        with patch.object(main.asyncio, "sleep", side_effect=cancel_on_sleep):
            with self.assertRaises(HTTPException) as error:
                await main.save_preset(req)
        self.assertEqual(error.exception.status_code, 499)
        self.assertEqual(error.exception.detail, "Save cancelled by user")
        self.assertTrue(any(b"\xc1\x02'\x00" in w for w in fake_sign.writes))
        self.assertTrue(any(b"\xc1\x02\x04\x02\x00\x01" in w for w in fake_sign.writes))
        self.assertFalse((Path(self.directory.name) / "current.gif").exists())

    async def test_clock_save_and_cancellation(self):
        fake_sign = FakeSign()
        main.connected_client = fake_sign
        clock_preset = main.PushTextRequest(mode="clock", clockStyle="default", timeFormat="12h")
        req = main.SavePresetRequest(slot_id=10, address=FakeSign.address, preset=clock_preset, progress_id="test-clock-save")

        # 1. Normal save of Clock to slot 10 (slot 11)
        with patch.object(main.asyncio, "sleep", new=AsyncMock()):
            result = await main.save_preset(req)
        self.assertTrue(result["written_to_sign"])
        self.assertEqual(result["preview_url"], "/static/preset_aabbccddeeff_10.gif")
        self.assertTrue((Path(self.directory.name) / "preset_aabbccddeeff_10.json").exists())
        self.assertTrue((Path(self.directory.name) / "preset_aabbccddeeff_10.gif").exists())
        self.assertEqual(main.hardware_slots_state.get(10, {}).get("key"), "clock")

        # 2. Cancelled save of Clock
        cancel_req = main.SavePresetRequest(slot_id=10, address=FakeSign.address, preset=clock_preset, progress_id="test-clock-cancel")
        async def cancel_on_sleep(*args, **kwargs):
            await main.cancel_save_preset_by_id("test-clock-cancel")

        with patch.object(main.asyncio, "sleep", side_effect=cancel_on_sleep):
            with self.assertRaises(HTTPException) as error:
                await main.save_preset(cancel_req)
        self.assertEqual(error.exception.status_code, 499)
        self.assertEqual(error.exception.detail, "Save cancelled by user")

    async def test_rejected_chunk_stops_before_commit_and_keeps_cache(self):
        previous = Path(self.directory.name) / "preset_aabbccddeeff_8.gif"
        previous.write_bytes(b"last good preset")
        # Predict the SNO of the first chunk: init and header precede it,
        # after the three playback/power packets sent before the transfer.
        main.connected_client = FakeSign(reject_sno=(main.protocol._sno + 5) % 0xFFFF)
        with patch.object(main.asyncio, "sleep", new=AsyncMock()):
            with self.assertRaises(HTTPException) as error:
                await main.save_preset(self.request())
        self.assertIn("rejected chunk 1", error.exception.detail)
        self.assertEqual(previous.read_bytes(), b"last good preset")
        self.assertFalse((Path(self.directory.name) / "preset_aabbccddeeff_8.json").exists())
        commit_tag = bytes([0x35, 0x19])
        self.assertFalse(any(commit_tag in w for w in main.connected_client.writes))

    async def test_unacknowledged_transfer_is_not_success(self):
        main.connected_client = FakeSign(silent=True)
        with patch.object(main.asyncio, "sleep", new=AsyncMock()):
            with self.assertRaises(HTTPException) as error:
                await main.save_preset(self.request())
        self.assertIn("did not confirm", error.exception.detail)
        self.assertFalse((Path(self.directory.name) / "preset_aabbccddeeff_8.json").exists())

    async def test_live_pushes_refuse_disconnected_sign(self):
        main.connected_client = None
        for call in (
            lambda: main.push_text(main.PushTextRequest(mode="text", text="HI")),
            lambda: main.set_clock(on=True, clock_style="default"),
            lambda: main.clear(),
            lambda: main.set_power(True),
        ):
            with self.assertRaises(HTTPException) as error:
                await call()
            self.assertEqual(error.exception.status_code, 409)
        self.assertFalse((Path(self.directory.name) / "current.gif").exists())
        self.assertFalse((Path(self.directory.name) / "current.png").exists())

    async def test_failed_clock_save_keeps_previous_cache(self):
        previous = Path(self.directory.name) / "preset_aabbccddeeff_10.json"
        previous.write_text('{"mode": "text", "text": "last good"}')
        main.connected_client = FakeSign(fail_at=1)
        req = main.SavePresetRequest(slot_id=10, address=FakeSign.address, preset=main.PushTextRequest(mode="clock", clockStyle="default"), progress_id="clock-fail")
        with patch.object(main.asyncio, "sleep", new=AsyncMock()):
            with self.assertRaises(HTTPException):
                await main.save_preset(req)
        self.assertEqual(json.loads(previous.read_text())["text"], "last good")
        self.assertFalse((Path(self.directory.name) / "preset_aabbccddeeff_10.gif").exists())


if __name__ == "__main__":
    unittest.main()
