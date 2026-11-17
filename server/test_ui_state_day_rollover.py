"""Offline tests for last_pushed_date persistence in server/main.py."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from starlette.requests import Request

import main


class _DummyRequest:
    def __init__(self, payload: dict):
        self._payload = payload

    async def json(self):
        return self._payload


class UiStateDayRolloverTests(unittest.IsolatedAsyncioTestCase):
    async def test_ui_state_persists_last_pushed_date_across_reload(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_file = os.path.join(tmpdir, "ui_state.json")
            with patch.object(main, "UI_STATE_FILE", state_file), \
                 patch.object(main, "active_last_pushed_id", None), \
                 patch.object(main, "active_last_pushed_date", None), \
                 patch.object(main, "active_manual_override", False):
                res = await main.update_ui_state(_DummyRequest({
                    "last_pushed_id": "hw-slot-3",
                    "last_pushed_date": "2026-11-13",
                    "is_manual_override": True,
                }))
                self.assertEqual(res["last_pushed_id"], "hw-slot-3")
                self.assertEqual(res["last_pushed_date"], "2026-11-13")
                self.assertTrue(res["is_manual_override"])

                with open(state_file, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                self.assertEqual(saved["last_pushed_date"], "2026-11-13")

                main.active_last_pushed_id = None
                main.active_last_pushed_date = None
                main.active_manual_override = False
                main._load_ui_state()

                self.assertEqual(main.active_last_pushed_id, "hw-slot-3")
                self.assertEqual(main.active_last_pushed_date, "2026-11-13")
                self.assertTrue(main.active_manual_override)

                status = await main.get_status()
                self.assertEqual(status["last_pushed_date"], "2026-11-13")
                self.assertTrue(status["is_manual_override"])


if __name__ == "__main__":
    unittest.main()
