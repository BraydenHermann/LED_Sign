"""The server's event text must match client/src/eventText.js exactly."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from event_text import fit_event_sign_text, format_clock
import datetime
import main

# Outputs of fitEventSignText from client/src/eventText.js for these inputs.
JS_REFERENCE = [
    ["Standup - Fullstack Team", "10:15 am", "Standup - Fullstack 10:15"],
    ["Josue senat", "1:45 pm", "Josue senat - 1:45 pm"],
    ["A very long meeting title about quarterly planning", "11:00 am", "A very long meeting 11:00"],
    ["", "2:00 pm", "2:00 pm"],
    ["Short", "", "Short"],
]


class EventTextTests(unittest.TestCase):
    def test_matches_client_fitting(self):
        for summary, end, expected in JS_REFERENCE:
            self.assertEqual(fit_event_sign_text(summary, end), expected)

    def test_clock_matches_intl_en_us(self):
        self.assertEqual(format_clock(datetime.datetime(2026, 1, 1, 0, 5)), "12:05 am")
        self.assertEqual(format_clock(datetime.datetime(2026, 1, 1, 13, 45)), "1:45 pm")


class BackgroundEventTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.static = directory.name
        patcher = patch.object(main, "STATIC_DIR", self.static)
        patcher.start()
        self.addCleanup(patcher.stop)

    async def test_new_event_is_saved_to_slot_one_like_the_dashboard(self):
        end = datetime.datetime(2026, 11, 2, 13, 45).astimezone().isoformat()
        with patch.object(main, "save_preset", new=AsyncMock()) as save:
            await main.show_event_in_slot_one("AA:BB:CC:DD:EE:FF", "Josue senat", end)
        req = save.call_args.args[0]
        self.assertEqual(req.slot_id, 0)
        self.assertEqual(req.preset.text, "Josue senat - 1:45 pm")
        self.assertEqual(req.preset.animation, "continuous left shift")
        self.assertNotIn("|", req.preset.text)

    async def test_event_already_in_slot_one_is_just_played(self):
        end = datetime.datetime(2026, 11, 2, 13, 45).astimezone().isoformat()
        Path(self.static, "preset_aabbccddeeff_0.json").write_text(json.dumps({"text": "Josue senat - 1:45 pm"}))
        with patch.object(main, "save_preset", new=AsyncMock()) as save, \
             patch.object(main, "_play_preset", new=AsyncMock()) as play, \
             patch.object(main, "require_connected_sign"), \
             patch.object(main, "preset_switch_lock", asyncio.Lock()):
            await main.show_event_in_slot_one("AA:BB:CC:DD:EE:FF", "Josue senat", end)
        save.assert_not_called()
        play.assert_awaited_once_with(0, "AA:BB:CC:DD:EE:FF")


if __name__ == "__main__":
    unittest.main()
