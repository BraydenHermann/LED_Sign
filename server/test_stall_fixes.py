"""Large preset data must not be parsed/re-encoded on the event loop."""
import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.responses import FileResponse
from starlette.requests import Request

import main


def _post_request(body: bytes) -> Request:
    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}
    return Request({"type": "http", "method": "POST", "path": "/api/local-presets",
                    "headers": [], "query_string": b"", "state": {}}, receive)


class LocalPresetsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "local_presets.json")
        self.patch = patch.object(main, "LOCAL_PRESETS_FILE", self.path)
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.tmp.cleanup()

    def test_get_streams_file_without_parsing(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write('[{"id":"a"}]')
        res = asyncio.run(main.get_local_presets())
        self.assertIsInstance(res, FileResponse)
        self.assertEqual(res.path, self.path)
        self.assertIn("x-local-presets-ts", res.headers)

    def test_get_without_file_returns_empty_list(self):
        res = asyncio.run(main.get_local_presets())
        self.assertEqual(json.loads(res.body), [])

    def test_save_writes_compact_json_and_counts(self):
        presets = [{"id": "a", "pixels": [1, 2, 3]}, {"id": "b"}]
        res = asyncio.run(main.save_local_presets(_post_request(json.dumps(presets, indent=2).encode())))
        self.assertEqual(res["count"], 2)
        with open(self.path, encoding="utf-8") as f:
            raw = f.read()
        self.assertNotIn("\n", raw)
        self.assertEqual(json.loads(raw), presets)

    def test_save_rejects_non_list(self):
        with self.assertRaises(main.HTTPException) as ctx:
            asyncio.run(main.save_local_presets(_post_request(b'{"id": "a"}')))
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertFalse(os.path.exists(self.path))


class HardwareSlotsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patches = [patch.object(main, "STATIC_DIR", self.tmp.name),
                        patch.dict(main._slot_preview_cache, clear=True)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.tmp.cleanup()

    def test_builds_json_and_reuses_parsed_preview(self):
        jf = os.path.join(self.tmp.name, "preset_aabb_0.json")
        with open(jf, "w") as f:
            json.dump({"text": "Hi"}, f)
        state = {0: {"slot_id": 0, "occupied": True}}

        body = json.loads(main._build_hardware_slots_json("aabb", state))
        slot0 = body["slots"][0]
        self.assertEqual(slot0["preset_data"], {"text": "Hi"})
        self.assertTrue(slot0["occupied"] and slot0["on_sign"])
        self.assertFalse(body["slots"][1]["occupied"])

        with patch.object(main._json, "load", side_effect=AssertionError("re-parsed unchanged file")):
            main._build_hardware_slots_json("aabb", state)

    def test_recovers_pixels_from_compact_rgb(self):
        import base64
        jf = os.path.join(self.tmp.name, "preset_aabb_2.json")
        with open(jf, "w") as f:
            json.dump({"pixelsRgbB64": base64.b64encode(bytes([255, 0, 0, 0, 255, 0])).decode()}, f)
        body = json.loads(main._build_hardware_slots_json("aabb", {}))
        self.assertEqual(body["slots"][2]["preset_data"], {"pixels": ["#ff0000", "#00ff00"]})


if __name__ == "__main__":
    unittest.main()
