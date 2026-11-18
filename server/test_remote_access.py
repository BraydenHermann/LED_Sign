"""Checks for VPN remote access: allowlist parsing and the backend gate."""
import asyncio
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

import main
import remote_access


class RemoteAccessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.config = os.path.join(self.tmp.name, ".remote_access.json")
        self.patcher = patch.object(remote_access, "CONFIG_FILE", self.config)
        self.patcher.start()
        self.denied_file = os.path.join(self.tmp.name, ".remote_access_denied.json")
        self.denied_patcher = patch.object(remote_access, "DENIED_FILE", self.denied_file)
        self.denied_patcher.start()
        remote_access._cache["mtime"] = object()  # force reload
        # Never read this machine's real ARP table in tests.
        self.arp_patcher = patch.object(remote_access, "_read_arp_table", return_value={})
        self.arp_patcher.start()
        remote_access._arp_cache["at"] = float("-inf")

    def tearDown(self):
        self.patcher.stop()
        self.denied_patcher.stop()
        self.arp_patcher.stop()
        self.tmp.cleanup()

    def test_loopback_always_allowed_and_others_denied_by_default(self):
        self.assertTrue(remote_access.is_allowed("127.0.0.1"))
        self.assertTrue(remote_access.is_allowed("::1"))
        self.assertTrue(remote_access.is_allowed("::ffff:127.0.0.1"))
        self.assertFalse(remote_access.is_allowed("172.16.0.5"))

    def test_single_ip_and_cidr_entries(self):
        saved = remote_access.set_allowed_entries(["172.16.0.5", " 10.9.0.0/24 ", "172.16.0.5/32"])
        self.assertEqual(saved, ["172.16.0.5", "10.9.0.0/24"])
        self.assertTrue(remote_access.is_allowed("172.16.0.5"))
        self.assertTrue(remote_access.is_allowed("10.9.0.77"))
        self.assertFalse(remote_access.is_allowed("172.16.0.6"))
        self.assertFalse(remote_access.is_allowed("10.9.1.1"))

    def test_invalid_entry_rejected(self):
        with self.assertRaises(ValueError):
            remote_access.set_allowed_entries(["not-an-ip"])

    def test_recent_denied_hides_now_allowed_addresses(self):
        self.assertEqual(remote_access.get_recent_denied(), [])
        with open(self.denied_file, "w", encoding="utf-8") as f:
            json.dump([{"ip": "172.16.0.5", "last_seen": 1.0}, {"ip": "::ffff:10.0.0.9", "last_seen": 2.0}, "junk"], f)
        self.assertEqual([r["ip"] for r in remote_access.get_recent_denied()], ["172.16.0.5", "10.0.0.9"])
        remote_access.set_allowed_entries(["172.16.0.0/24"])
        self.assertEqual([r["ip"] for r in remote_access.get_recent_denied()], ["10.0.0.9"])

    def test_parse_ipconfig(self):
        sample = (
            "Windows IP Configuration\n\n"
            "Unknown adapter NordLynx:\n\n"
            "   IPv4 Address. . . . . . . . . . . : 10.5.0.2\n\n"
            "Wireless LAN adapter Wi-Fi:\n\n"
            "   IPv4 Address. . . . . . . . . . . : 192.168.1.20(Preferred)\n"
            "   Subnet Mask . . . . . . . . . . . : 255.255.254.0\n"
        )
        self.assertEqual(remote_access.parse_ipconfig(sample), [
            {"name": "NordLynx", "ip": "10.5.0.2"},
            {"name": "Wi-Fi", "ip": "192.168.1.20"},
        ])

    def test_incomplete_scan_keeps_last_good_addresses(self):
        good = [{"name": "Wi-Fi", "ip": "192.168.1.20", "primary": True}]
        unnamed = [{"name": "", "ip": "10.5.0.2", "primary": False}]
        with patch.dict(remote_access._address_cache, {"value": good, "at": 0.0, "refreshing": False}),                 patch.object(remote_access, "_scan_local_addresses", return_value=unnamed):
            self.assertEqual(remote_access._refresh_addresses(), good)
            self.assertEqual(remote_access._address_cache["value"], good)

    def _request(self, client_ip="127.0.0.1", peer_header=None, method="GET"):
        headers = []
        if peer_header:
            headers.append((remote_access.REMOTE_PEER_HEADER.encode(), peer_header.encode()))
        return Request({
            "type": "http", "method": method, "path": "/api/remote-access", "headers": headers,
            "query_string": b"", "client": (client_ip, 50000), "state": {},
        })

    def _through_gate(self, request):
        async def call_next(req):
            return "passed"
        return asyncio.run(main.remote_access_middleware(request, call_next))

    def test_backend_gate_uses_forwarded_peer(self):
        remote_access.set_allowed_entries(["172.16.0.5"])

        denied = self._through_gate(self._request(peer_header="172.16.0.9"))
        self.assertEqual(denied.status_code, 403)

        remote_req = self._request(peer_header="172.16.0.5")
        self.assertEqual(self._through_gate(remote_req), "passed")
        local_req = self._request()
        self.assertEqual(self._through_gate(local_req), "passed")

        with patch.object(remote_access, "list_local_addresses", return_value=[]):
            self.assertTrue(asyncio.run(main.get_remote_access(remote_req))["is_remote"])
            self.assertFalse(asyncio.run(main.get_remote_access(local_req))["is_remote"])

        # Remote devices cannot edit the allowlist; the host can.
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(main.set_remote_access(main.RemoteAccessConfigRequest(allowed_ips=["0.0.0.0/0"]), remote_req))
        self.assertEqual(ctx.exception.status_code, 403)
        self.assertEqual(remote_access.get_allowed_entries(), ["172.16.0.5"])

        res = asyncio.run(main.set_remote_access(main.RemoteAccessConfigRequest(allowed_ips=["172.16.0.5", "172.16.0.8"]), local_req))
        self.assertEqual(res["allowed_ips"], ["172.16.0.5", "172.16.0.8"])

    def test_direct_non_loopback_client_checked(self):
        self.assertEqual(self._through_gate(self._request(client_ip="192.168.1.50")).status_code, 403)
        remote_access.set_allowed_entries(["192.168.1.50"])
        self.assertEqual(self._through_gate(self._request(client_ip="192.168.1.50")), "passed")

    def test_forwarded_header_ignored_on_direct_connections(self):
        # A direct (non-proxy) client can't claim to be another allowed device.
        remote_access.set_allowed_entries(["172.16.0.5"])
        req = self._request(client_ip="192.168.1.50", peer_header="172.16.0.5")
        self.assertEqual(self._through_gate(req).status_code, 403)

    def test_forwarded_loopback_rejected(self):
        self.assertEqual(self._through_gate(self._request(peer_header="127.0.0.1")).status_code, 403)

    def test_dns_rebinding_host_rejected(self):
        req = self._request()
        req.scope["headers"].append((b"host", b"evil.example.com"))
        self.assertEqual(self._through_gate(req).status_code, 403)
        for host in ("localhost:8000", "127.0.0.1:5173", "192.168.9.227:5173", "[::1]:8000", "app.localhost"):
            self.assertTrue(remote_access.is_trusted_host_header(host), host)
        self.assertFalse(remote_access.is_trusted_host_header("attacker.com:8000"))

    def test_parse_arp(self):
        windows = (
            "Interface: 192.168.9.227 --- 0x4\n"
            "  Internet Address      Physical Address      Type\n"
            "  192.168.8.136         fa-7b-2c-4a-7a-92     dynamic   \n"
            "  192.168.9.255         ff-ff-ff-ff-ff-ff     static    \n"
            "  224.0.0.22            01-00-5e-00-00-16     static    \n"
        )
        self.assertEqual(remote_access.parse_arp(windows), {"192.168.8.136": "fa-7b-2c-4a-7a-92"})
        unix = "? (10.0.0.1) at a:b:c:d:e:f on en0 ifscope [ethernet]\n"
        self.assertEqual(remote_access.parse_arp(unix), {"10.0.0.1": "0a-0b-0c-0d-0e-0f"})

    def test_allowed_address_pinned_to_its_device(self):
        arp = {"172.16.0.5": "aa-aa-aa-aa-aa-aa"}
        with patch.object(remote_access, "_read_arp_table", side_effect=lambda: dict(arp)):
            remote_access.set_allowed_entries(["172.16.0.5", "10.9.0.0/24"])
            self.assertEqual(remote_access.get_pinned_macs(), {"172.16.0.5": "aa-aa-aa-aa-aa-aa"})
            self.assertIsNone(remote_access.check_peer("172.16.0.5"))

            # Another office device takes over the allowed address.
            arp["172.16.0.5"] = "bb-bb-bb-bb-bb-bb"
            remote_access._arp_cache["at"] = float("-inf")
            self.assertEqual(remote_access.check_peer("172.16.0.5"), "mac_mismatch")
            self.assertEqual(self._through_gate(self._request(peer_header="172.16.0.5")).status_code, 403)
            denied = remote_access.get_recent_denied()
            self.assertEqual([(d["ip"], d.get("reason")) for d in denied], [("172.16.0.5", "mac_mismatch")])

            # The host re-trusts it on purpose.
            remote_access.set_allowed_entries(["172.16.0.5", "10.9.0.0/24"], repin=["172.16.0.5"])
            self.assertIsNone(remote_access.check_peer("172.16.0.5"))
            self.assertEqual(remote_access.get_recent_denied(), [])

    def test_unpinned_entry_pins_first_device_seen(self):
        remote_access._write_config({"allowed_ips": ["172.16.0.5"]})
        remote_access._arp_cache["at"] = float("-inf")
        with patch.object(remote_access, "_read_arp_table", return_value={"172.16.0.5": "cc-cc-cc-cc-cc-cc"}):
            self.assertIsNone(remote_access.check_peer("172.16.0.5"))
        self.assertEqual(remote_access.get_pinned_macs(), {"172.16.0.5": "cc-cc-cc-cc-cc-cc"})

    def test_parse_wlan_ssid(self):
        sample = (
            "There is 1 interface on the system:\n\n"
            "    Name                   : Wi-Fi\n"
            "    State                  : connected\n"
            "    SSID                   : RavenConnected\n"
            "    AP BSSID               : 9e:25:4a:14:75:db\n"
        )
        self.assertEqual(remote_access.parse_wlan_ssid(sample), "RavenConnected")
        self.assertIsNone(remote_access.parse_wlan_ssid("State : disconnected\n"))

    def test_ssid_scoped_ips_only_allowed_on_matching_ssid_and_preserved(self):
        remote_access._write_config({
            "allowed_ips": ["192.168.8.136"],
            "ssid_scoped_ips": {"RavenConnected": ["192.168.9.162"]},
        })
        with patch.object(remote_access, "current_wifi_ssid", return_value="OtherWiFi"):
            self.assertTrue(remote_access.is_allowed("192.168.8.136"))
            self.assertFalse(remote_access.is_allowed("192.168.9.162"))

        with patch.object(remote_access, "current_wifi_ssid", return_value="RavenConnected"), \
             patch.object(remote_access, "_read_arp_table", return_value={"192.168.9.162": "dd-dd-dd-dd-dd-dd"}):
            remote_access._arp_cache["at"] = float("-inf")
            self.assertTrue(remote_access.is_allowed("192.168.9.162"))
            self.assertIsNone(remote_access.check_peer("192.168.9.162"))
            self.assertEqual(remote_access.get_pinned_macs().get("192.168.9.162"), "dd-dd-dd-dd-dd-dd")

        # Updating allowed_ips via set_allowed_entries preserves ssid_scoped_ips.
        remote_access.set_allowed_entries(["192.168.8.136"])
        self.assertEqual(remote_access.get_ssid_scoped_entries(), {"RavenConnected": ["192.168.9.162"]})


if __name__ == "__main__":
    unittest.main()
