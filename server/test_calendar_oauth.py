import unittest
from unittest.mock import MagicMock, patch
import sys
import os
import tempfile
import json

# Provide dummy mocks for google modules so the test can run anywhere
sys.modules['google'] = MagicMock()
sys.modules['google.auth'] = MagicMock()
sys.modules['google.auth.transport'] = MagicMock()
sys.modules['google.auth.transport.requests'] = MagicMock()
sys.modules['google.oauth2'] = MagicMock()
sys.modules['google.oauth2.credentials'] = MagicMock()
sys.modules['google_auth_oauthlib'] = MagicMock()
sys.modules['google_auth_oauthlib.flow'] = MagicMock()
sys.modules['googleapiclient'] = MagicMock()
sys.modules['googleapiclient.discovery'] = MagicMock()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from calendar_service import CalendarService


class TestCalendarOAuth(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.creds_path = os.path.join(self.temp_dir, "credentials.json")
        self.token_path = os.path.join(self.temp_dir, "token.json")
        with open(self.creds_path, "w") as f:
            json.dump({"web": {"client_id": "test_id", "client_secret": "test_secret"}}, f)
        self.service = CalendarService(credentials_path=self.creds_path, token_path=self.token_path)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_get_auth_url_generates_and_persists_pkce_verifier(self):
        mock_flow = MagicMock()
        mock_flow.code_verifier = "test_code_verifier_123"
        mock_flow.authorization_url.return_value = ("https://accounts.google.com/o/oauth2/auth?test=1", "state_abc")

        with patch.object(self.service, '_create_flow', return_value=mock_flow):
            url = self.service.get_auth_url()

        self.assertEqual(url, "https://accounts.google.com/o/oauth2/auth?test=1")
        # Check in-memory state lookup
        self.assertEqual(self.service._get_code_verifier("state_abc"), "test_code_verifier_123")
        # Check disk state lookup
        self.assertTrue(os.path.exists(self.service._state_storage_path))

    def test_fetch_token_uses_persisted_verifier(self):
        # Setup stored state
        self.service._save_oauth_state("state_xyz", "saved_verifier_xyz")

        mock_flow = MagicMock()
        mock_flow.credentials = MagicMock()
        mock_flow.credentials.to_json.return_value = '{"token": "abc"}'

        with patch.object(self.service, '_create_flow', return_value=mock_flow):
            self.service.fetch_token(code="auth_code_123", state="state_xyz")

        # Verify fetch_token was called with code and code_verifier
        mock_flow.fetch_token.assert_called_once_with(code="auth_code_123", code_verifier="saved_verifier_xyz")
        # Verify credentials written to token_path
        self.assertTrue(os.path.exists(self.token_path))
        with open(self.token_path) as f:
            self.assertEqual(f.read(), '{"token": "abc"}')


if __name__ == '__main__':
    unittest.main()
