"""Checks for posting the VPN remote link to Google Chat."""
import json
import os
import tempfile
import unittest
from unittest.mock import patch

import link_notifier

WEBHOOK = "https://chat.googleapis.com/v1/spaces/AAA/messages?key=secret123456"


class LinkNotifierTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patchers = [
            patch.object(link_notifier, "WEBHOOK_FILE", os.path.join(self.tmp.name, "webhook.json")),
            patch.object(link_notifier, "LEGACY_WEBHOOK_FILE", os.path.join(self.tmp.name, ".tunnel_webhook")),
        ]
        for p in self.patchers:
            p.start()

    def tearDown(self):
        for p in self.patchers:
            p.stop()
        self.tmp.cleanup()

    def test_migrates_old_tunnel_webhook_without_old_link(self):
        with open(link_notifier.LEGACY_WEBHOOK_FILE, "w", encoding="utf-8") as f:
            json.dump({"webhook_url": WEBHOOK, "auto_send": True, "last_sent_url": "https://x.trycloudflare.com"}, f)
        cfg = link_notifier.get_config()
        self.assertEqual(cfg["webhook_url"], WEBHOOK)
        self.assertTrue(cfg["auto_send"])
        self.assertEqual(cfg["last_sent_link"], "")

    def test_public_config_masks_secret(self):
        link_notifier.set_config(webhook_url=WEBHOOK)
        public = link_notifier.get_public_config()
        self.assertTrue(public["has_webhook"])
        self.assertNotIn("secret", public["masked_webhook_url"])
        self.assertTrue(public["masked_webhook_url"].endswith("123456"))
        # Saving the masked value back leaves the real URL untouched.
        link_notifier.set_config(webhook_url=public["masked_webhook_url"])
        self.assertEqual(link_notifier.get_config()["webhook_url"], WEBHOOK)

    def test_rejects_non_google_chat_url(self):
        with self.assertRaises(ValueError):
            link_notifier.set_config(webhook_url="https://example.com/hook")

    def test_link_prefers_office_network_adapter(self):
        addrs = [{"ip": "10.5.0.2", "name": "NordLynx", "primary": False},
                 {"ip": "192.168.1.20", "name": "Wi-Fi", "primary": True}]
        self.assertEqual(link_notifier.link_for(addrs), "http://192.168.1.20:5173/")
        self.assertEqual(link_notifier.link_for([addrs[0]]), "")

    def test_watcher_baselines_then_sends_only_after_stable_change(self):
        link_notifier.set_config(webhook_url=WEBHOOK, auto_send=True)
        state = {"candidate": ""}
        sent = []

        def fake_send(link, changed=False):
            sent.append((link, changed))
            link_notifier.set_config(last_sent_link=link, known_link=link)
            return {"success": True}

        links = iter(["http://a:5173/", "http://a:5173/", "http://b:5173/", "http://b:5173/", "http://b:5173/"])
        with patch.object(link_notifier, "current_link", side_effect=lambda fresh=False: next(links)), \
                patch.object(link_notifier, "send_link", side_effect=fake_send):
            for _ in range(5):
                link_notifier.check_and_notify(state)

        # First sighting is only recorded; the change to b is sent once, after two checks.
        self.assertEqual(sent, [("http://b:5173/", True)])

    def test_watcher_does_nothing_when_auto_send_off(self):
        link_notifier.set_config(webhook_url=WEBHOOK, auto_send=False, known_link="http://a:5173/")
        with patch.object(link_notifier, "current_link", return_value="http://b:5173/"), \
                patch.object(link_notifier, "send_link") as send:
            for _ in range(3):
                link_notifier.check_and_notify({"candidate": ""})
        send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
