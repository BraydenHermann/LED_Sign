"""Offline checks that a manual sign choice supersedes an old reconnect."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

import main


class ConnectionPriorityTests(unittest.IsolatedAsyncioTestCase):
    async def test_opening_sign_picker_pauses_old_reconnect(self):
        with patch.object(main, "_suppress_auto_reconnect", False), \
             patch.object(main, "_connection_intent", 3):
            self.assertEqual(await main.pause_reconnect(), {"status": "paused"})
            self.assertTrue(main._suppress_auto_reconnect)
            self.assertEqual(main._connection_intent, 4)

    async def test_stale_reconnect_never_takes_the_connection_lock(self):
        with patch.object(main, "_suppress_auto_reconnect", False), \
             patch.object(main, "_connection_intent", 2), \
             patch.object(main, "connected_client", None), \
             patch.object(main, "_connect_internal", new_callable=AsyncMock) as connect:
            await main._auto_reconnect("FF:24:10:29:44:9B", delay=0, intent=1)
            connect.assert_not_awaited()

    async def test_reconnect_uses_the_intent_from_when_it_was_scheduled(self):
        with patch.object(main, "_suppress_auto_reconnect", False), \
             patch.object(main, "_connection_intent", 2), \
             patch.object(main, "connected_client", None), \
             patch.object(main, "_connect_internal", new_callable=AsyncMock) as connect:
            connect.return_value = {"status": "success"}
            await main._auto_reconnect("FF:24:10:29:44:9B", delay=0, intent=2)
            self.assertEqual(connect.await_args.kwargs["intent"], 2)

    async def test_sign_switch_waits_for_slot_save(self):
        lock = asyncio.Lock()
        await lock.acquire()
        with patch.object(main, "preset_switch_lock", lock), \
             patch.object(main, "_connect_internal", new_callable=AsyncMock) as connect:
            connect.return_value = {"status": "success"}
            task = asyncio.create_task(main.connect(main.ConnectRequest(address="FF:24:10:29:44:9B")))
            await asyncio.sleep(0)
            connect.assert_not_awaited()
            lock.release()
            self.assertEqual(await task, {"status": "success"})
            connect.assert_awaited_once()

    async def test_disconnect_stops_old_signs_streaming_worker(self):
        with patch.object(main, "connected_client", None), \
             patch.object(main, "preset_switch_lock", asyncio.Lock()), \
             patch.object(main, "connect_lock", asyncio.Lock()), \
             patch.object(main, "cancel_active_worker", new_callable=AsyncMock) as cancel:
            self.assertEqual(await main.disconnect(), {"status": "success"})
            cancel.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
