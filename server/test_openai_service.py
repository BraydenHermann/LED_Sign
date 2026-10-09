"""
Unit tests for server/openai_service.py
"""

import sys
import os
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import openai_service


class TestOpenAIService(unittest.TestCase):

    def test_status_and_hardware_limits(self):
        status = openai_service.check_status()
        self.assertIn("configured", status)
        self.assertIn("hardware_limits", status)
        limits = status["hardware_limits"]
        self.assertEqual(limits["width"], 64)
        self.assertEqual(limits["height"], 20)
        self.assertEqual(limits["max_frames"], 300)
        self.assertEqual(limits["aspect_ratio"], "3.2:1")

    @patch("openai_service.requests.post")
    def test_call_openai_chat_mock(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "```python\nprint('hello')\n```"
                    }
                }
            ]
        }
        mock_post.return_value = mock_resp

        reply = openai_service._call_openai_chat(
            [{"role": "user", "content": "test"}],
            model="gpt-4o-mini",
            api_key="sk-testkey12345"
        )
        self.assertIn("print('hello')", reply)

    @patch("openai_service.requests.post")
    def test_call_openai_quota_error(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 429
        mock_resp.json.return_value = {
            "error": {
                "message": "You exceeded your current quota, please check your plan and billing details."
            }
        }
        mock_post.return_value = mock_resp

        with self.assertRaises(RuntimeError) as ctx:
            openai_service._call_openai_chat(
                [{"role": "user", "content": "test"}],
                model="gpt-4o-mini",
                api_key="sk-testkey12345"
            )
        self.assertIn("quota", str(ctx.exception).lower())


if __name__ == "__main__":
    unittest.main()
