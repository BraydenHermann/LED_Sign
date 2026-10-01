"""Offline regression checks: no Bluetooth device or calendar requests."""
import asyncio
import base64
import io
import json
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

    def __init__(self, fail_at=None):
        self.writes = []
        self.fail_at = fail_at

    async def write_gatt_char(self, uuid, data, response=True):
        self.writes.append(bytes(data))
        if len(self.writes) == self.fail_at:
            raise OSError("Simulated Bluetooth write failure")


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


if __name__ == "__main__":
    unittest.main()
