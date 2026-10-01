"""Launcher lifecycle tests with network and process calls mocked."""
import io
import unittest
from unittest.mock import Mock, patch
import launcher


class LauncherRestartTests(unittest.TestCase):
    def test_waits_for_old_listener_to_close_before_starting(self):
        with patch.object(launcher, 'port_open', side_effect=[True, True, False, False]), \
             patch.object(launcher.urllib.request, 'urlopen', return_value=io.BytesIO(b'{}')), \
             patch.object(launcher, 'stop_project_server') as stop, \
             patch.object(launcher.time, 'sleep') as sleep, \
             patch.object(launcher, 'launcher_log'), \
             patch.object(launcher, 'hidden_process_kwargs', return_value={}), \
             patch('builtins.open', return_value=Mock()), \
             patch.object(launcher.subprocess, 'Popen') as spawn:
            launcher.start_backend()
        stop.assert_called_once()
        sleep.assert_called_once_with(0.1)
        spawn.assert_called_once()

    def test_current_server_is_reused(self):
        with patch.object(launcher, 'port_open', return_value=True), \
             patch.object(launcher.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"api_version":2}')), \
             patch.object(launcher, 'launcher_log'), \
             patch.object(launcher, 'stop_project_server') as stop, \
             patch.object(launcher.subprocess, 'Popen') as spawn:
            launcher.start_backend()
        stop.assert_not_called()
        spawn.assert_not_called()


if __name__ == '__main__':
    unittest.main()
