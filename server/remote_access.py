"""
VPN-based remote access for LED Sign.

Remote control works over the work VPN (Pritunl) instead of a public tunnel.
This machine stays on the regular office network; remote devices connect to
the VPN, which routes them onto that network. Only the addresses/ranges in the
allowlist plus this machine may use the UI. Pritunl NATs VPN clients, so their
traffic arrives from the Pritunl server's office-network address, and that is
the address to allow.

The allowlist lives in server/.remote_access.json and is shared with the Vite
dev server (client/vite.config.js), which enforces it for the UI on port 5173.
"""
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
import time
from typing import Any, Dict, List, Optional

CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".remote_access.json")
# Written by the Vite gate: recent devices that were refused (newest first).
DENIED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".remote_access_denied.json")

# Header the Vite gate sets on proxied requests so the backend knows the real peer.
REMOTE_PEER_HEADER = "x-led-remote-peer"

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

_lock = threading.Lock()
_cache: Dict[str, Any] = {"mtime": None, "networks": []}


def normalize_ip(ip: Optional[str]) -> str:
    ip = (ip or "").strip()
    if ip.startswith("::ffff:"):
        ip = ip[7:]
    return ip


def is_loopback(ip: Optional[str]) -> bool:
    try:
        return ipaddress.ip_address(normalize_ip(ip)).is_loopback
    except ValueError:
        return False


def is_trusted_host_header(host: Optional[str]) -> bool:
    """True for Host headers naming this server by IP address or localhost."""
    host = (host or "").strip().lower()
    if not host:
        return True  # HTTP/1.0 clients and test harnesses send none
    if host.startswith("["):
        name = host[1:host.find("]")] if "]" in host else ""
    else:
        name = host.rsplit(":", 1)[0] if host.count(":") == 1 else host
    if name in ("localhost",) or name.endswith(".localhost"):
        return True
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        return False


def parse_entry(entry: str) -> ipaddress._BaseNetwork:
    """Accept a single IP (10.8.0.5) or a CIDR range (10.8.0.0/24)."""
    return ipaddress.ip_network(str(entry).strip(), strict=False)


def _read_config() -> Dict[str, Any]:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def get_allowed_entries() -> List[str]:
    entries = _read_config().get("allowed_ips") or []
    return [str(e).strip() for e in entries if str(e).strip()]


def get_ssid_scoped_entries() -> Dict[str, List[str]]:
    """Map of Wi-Fi SSID -> allowed IP/CIDR entries active only on that SSID."""
    raw = _read_config().get("ssid_scoped_ips") or {}
    if not isinstance(raw, dict):
        return {}
    result: Dict[str, List[str]] = {}
    for ssid, entries in raw.items():
        ssid_name = str(ssid).strip()
        if not ssid_name or not isinstance(entries, list):
            continue
        cleaned = [str(e).strip() for e in entries if str(e).strip()]
        if cleaned:
            result[ssid_name] = cleaned
    return result


_SSID_MAX_AGE = 5.0
_ssid_lock = threading.Lock()
_ssid_cache: Dict[str, Any] = {"at": float("-inf"), "ssid": None}
_SSID_LINE_RE = re.compile(r"^\s*SSID\s*:\s*(.+?)\s*$", re.MULTILINE)


def parse_wlan_ssid(output: str) -> Optional[str]:
    """Extract the connected Wi-Fi SSID from `netsh wlan show interfaces` output."""
    match = _SSID_LINE_RE.search(output or "")
    if not match:
        return None
    ssid = match.group(1).strip()
    return ssid or None


def current_wifi_ssid(max_age: float = _SSID_MAX_AGE) -> Optional[str]:
    """Return the currently connected Wi-Fi SSID on Windows, cached briefly."""
    if sys.platform != "win32":
        return None
    with _ssid_lock:
        if time.monotonic() - _ssid_cache["at"] <= max_age:
            return _ssid_cache["ssid"]
        ssid = None
        try:
            out = subprocess.check_output(
                ["netsh", "wlan", "show", "interfaces"],
                text=True, timeout=3, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW, errors="replace",
            )
            ssid = parse_wlan_ssid(out)
        except Exception:
            ssid = None
        _ssid_cache["ssid"] = ssid
        _ssid_cache["at"] = time.monotonic()
        return ssid


def _parse_networks(entries: List[str]) -> List[ipaddress._BaseNetwork]:
    networks = []
    for entry in entries:
        try:
            networks.append(parse_entry(entry))
        except ValueError:
            print(f"[remote-access] Ignoring invalid allowlist entry: {entry!r}")
    return networks


def _allowed_networks() -> List[ipaddress._BaseNetwork]:
    try:
        mtime = os.path.getmtime(CONFIG_FILE)
    except OSError:
        mtime = None
    with _lock:
        if _cache["mtime"] != mtime:
            networks = _parse_networks(get_allowed_entries())
            _cache["mtime"] = mtime
            _cache["networks"] = networks
        return list(_cache["networks"])


def is_allowed(ip: Optional[str]) -> bool:
    ip = normalize_ip(ip)
    if not ip:
        return False
    if is_loopback(ip):
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if any(addr in net for net in _allowed_networks() if net.version == addr.version):
        return True
    scoped = get_ssid_scoped_entries()
    if scoped:
        ssid = current_wifi_ssid()
        if ssid and ssid in scoped:
            return any(addr in net for net in _parse_networks(scoped[ssid]) if net.version == addr.version)
    return False


def _read_denied() -> List[Dict[str, Any]]:
    try:
        with open(DENIED_FILE, "r", encoding="utf-8") as f:
            rows = json.load(f)
    except (OSError, ValueError):
        return []
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def get_recent_denied() -> List[Dict[str, Any]]:
    """Recently refused devices: addresses that are still not allowed, and allowed
    addresses that were refused because a different device was using them."""
    pins = get_pinned_macs()
    result = []
    seen = set()
    for row in _read_denied():
        ip = normalize_ip(str(row.get("ip") or ""))
        if not ip or ip in seen:
            continue
        if row.get("reason") == "mac_mismatch":
            mac = normalize_mac(row.get("mac"))
            if mac and pins.get(ip) and pins[ip] != mac and is_allowed(ip):
                seen.add(ip)
                result.append({"ip": ip, "last_seen": row.get("last_seen"), "reason": "mac_mismatch"})
        elif not is_allowed(ip):
            seen.add(ip)
            result.append({"ip": ip, "last_seen": row.get("last_seen")})
    return result


def record_denied(ip: str, reason: str, mac: Optional[str] = None):
    """Remember a refused connection so the host can see it (same file as the Vite gate)."""
    row: Dict[str, Any] = {"ip": ip, "last_seen": time.time(), "reason": reason}
    if mac:
        row["mac"] = mac
    rows = [row] + [r for r in _read_denied() if normalize_ip(str(r.get("ip") or "")) != ip][:9]
    try:
        with open(DENIED_FILE, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=2)
    except OSError as e:
        print(f"[remote-access] Could not record denied device: {e}")


def set_allowed_entries(entries: List[str], repin: Optional[List[str]] = None) -> List[str]:
    """Save the allowlist. Single addresses are pinned to the network hardware
    (MAC) currently using them; `repin` re-trusts the device now using an address."""
    cleaned: List[str] = []
    for entry in entries:
        entry = str(entry).strip()
        if not entry:
            continue
        net = parse_entry(entry)  # raises ValueError on bad input
        text = str(net.network_address) if net.num_addresses == 1 else str(net)
        if text not in cleaned:
            cleaned.append(text)
    repin_set = {normalize_ip(ip) for ip in (repin or [])}
    old_config = _read_config()
    old_pins = get_pinned_macs()
    pins: Dict[str, str] = {}
    scoped = old_config.get("ssid_scoped_ips")
    scoped_single_ips: List[str] = []
    if isinstance(scoped, dict):
        for entries_list in scoped.values():
            if isinstance(entries_list, list):
                for e in entries_list:
                    e_str = str(e).strip()
                    if e_str and "/" not in e_str:
                        scoped_single_ips.append(e_str)
    for text in cleaned + scoped_single_ips:
        if "/" in text:
            continue
        if text in old_pins and text not in repin_set:
            pins[text] = old_pins[text]
            continue
        mac = neighbor_mac(text, max_age=0)
        if mac:
            pins[text] = mac
    new_config: Dict[str, Any] = {"allowed_ips": cleaned, "pinned_macs": pins}
    if isinstance(scoped, dict):
        new_config["ssid_scoped_ips"] = scoped
    _write_config(new_config)
    return cleaned


def _write_config(data: Dict[str, Any]):
    tmp = CONFIG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, CONFIG_FILE)


# -- Spoofing protection --------------------------------------------------------
#
# A TCP connection can't come from a forged address off the local network, but
# any device on the office network can take over an allowed address (e.g. the
# Pritunl server's). Each allowed single address is pinned to the MAC address
# that was using it when it was allowed; a different device using that address
# is refused. Routed (off-link) peers have no ARP entry and rely on the IP check.

_MAC_RE = re.compile(r"([0-9a-fA-F]{1,2}(?:[-:][0-9a-fA-F]{1,2}){5})")
_IP_RE = re.compile(r"(\d{1,3}(?:\.\d{1,3}){3})")
_ARP_MAX_AGE = 2.0
_arp_lock = threading.Lock()
_arp_cache: Dict[str, Any] = {"at": float("-inf"), "table": {}}
# Separate worker so ARP lookups never wait behind slower adapter scans.
ARP_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="remote-access-arp")


def normalize_mac(mac: Optional[str]) -> Optional[str]:
    if not mac:
        return None
    parts = re.split(r"[-:]", str(mac).strip().lower())
    if len(parts) != 6:
        return None
    try:
        return "-".join(f"{int(p, 16):02x}" for p in parts)
    except ValueError:
        return None


def parse_arp(output: str) -> Dict[str, str]:
    """IP -> MAC from `arp -a` output (Windows and macOS/Linux formats)."""
    table: Dict[str, str] = {}
    for line in output.splitlines():
        ip_match = _IP_RE.search(line)
        mac_match = _MAC_RE.search(line)
        if not ip_match or not mac_match:
            continue
        mac = normalize_mac(mac_match.group(1))
        if not mac or mac in ("ff-ff-ff-ff-ff-ff", "00-00-00-00-00-00") or mac.startswith("01-00-5e"):
            continue
        table[ip_match.group(1)] = mac
    return table


def _read_arp_table() -> Dict[str, str]:
    cmd = ["arp", "-a"] if sys.platform == "win32" else ["arp", "-an"]
    out = subprocess.check_output(
        cmd, text=True, timeout=5, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW, errors="replace",
    )
    return parse_arp(out)


def neighbor_mac(ip: str, max_age: float = _ARP_MAX_AGE) -> Optional[str]:
    """MAC address the OS currently has for an on-link IP, or None if unknown."""
    ip = normalize_ip(ip)
    with _arp_lock:
        if time.monotonic() - _arp_cache["at"] > max_age:
            try:
                _arp_cache["table"] = _read_arp_table()
            except Exception as e:
                print(f"[remote-access] Could not read the ARP table: {e}")
                _arp_cache["table"] = {}
            _arp_cache["at"] = time.monotonic()
        return _arp_cache["table"].get(ip)


def get_pinned_macs() -> Dict[str, str]:
    pins = _read_config().get("pinned_macs") or {}
    if not isinstance(pins, dict):
        return {}
    result = {}
    for ip, mac in pins.items():
        mac = normalize_mac(mac)
        if mac:
            result[normalize_ip(str(ip))] = mac
    return result


def check_peer(ip: Optional[str]) -> Optional[str]:
    """None if this peer may connect, otherwise why not ('not_allowed' or 'mac_mismatch').
    Blocking (may run `arp`); call from a worker thread."""
    ip = normalize_ip(ip)
    if is_loopback(ip):
        return None
    if not is_allowed(ip):
        return "not_allowed"
    config = _read_config()
    allowed = {str(e).strip() for e in (config.get("allowed_ips") or [])}
    scoped = get_ssid_scoped_entries()
    if scoped:
        ssid = current_wifi_ssid()
        if ssid and ssid in scoped:
            allowed.update(scoped[ssid])
    pins = get_pinned_macs()
    current = neighbor_mac(ip)
    pinned = pins.get(ip)
    if pinned and current and current != pinned:
        print(f"[remote-access] Refused {ip}: it is now used by {current}, not the allowed device {pinned} (possible spoofing)")
        record_denied(ip, "mac_mismatch", current)
        return "mac_mismatch"
    if not pinned and current and ip in allowed:
        # Entries saved before pinning existed: trust the device using it now.
        pins[ip] = current
        _write_config({**config, "pinned_macs": pins})
    return None


def _windows_interfaces() -> List[Dict[str, str]]:
    cmd = [
        "powershell", "-NoProfile", "-NonInteractive", "-Command",
        "Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias,IPAddress | ConvertTo-Json -Compress",
    ]
    out = subprocess.check_output(
        cmd, text=True, timeout=20, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW,
    )
    rows = json.loads(out or "[]")
    if isinstance(rows, dict):
        rows = [rows]
    return [{"name": str(r.get("InterfaceAlias") or ""), "ip": str(r.get("IPAddress") or "")} for r in rows]


# Dedicated worker so the address scan never queues behind Bluetooth jobs.
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="remote-access")

_ADDRESS_CACHE_SECONDS = 60
_address_cache: Dict[str, Any] = {"at": 0.0, "value": None, "refreshing": False}
_address_lock = threading.Lock()


def list_local_addresses() -> List[Dict[str, Any]]:
    """This machine's IPv4 addresses, office-network (Wi-Fi/Ethernet) adapters first.

    Listing adapters can take several seconds on a busy machine, so callers get
    the last known list immediately and a stale list is refreshed in the background.
    Only the very first call (normally the startup warm-up) waits for a scan.
    """
    with _address_lock:
        cached = _address_cache["value"]
        stale = time.monotonic() - _address_cache["at"] >= _ADDRESS_CACHE_SECONDS
        start_refresh = cached is not None and stale and not _address_cache["refreshing"]
        if start_refresh:
            _address_cache["refreshing"] = True
    if cached is None:
        return list(_refresh_addresses())
    if start_refresh:
        threading.Thread(target=_refresh_addresses, daemon=True, name="remote-access-refresh").start()
    return list(cached)


def _refresh_addresses() -> List[Dict[str, Any]]:
    try:
        result = _scan_local_addresses()
        with _address_lock:
            previous = _address_cache["value"]
            # A scan that fell back to unnamed addresses is incomplete; keep the
            # last good list rather than lose the Wi-Fi/Ethernet adapter, and retry soon.
            if previous and not any(r["name"] for r in result) and any(r["name"] for r in previous):
                return list(previous)
            _address_cache.update(at=time.monotonic(), value=result)
        return result
    finally:
        with _address_lock:
            _address_cache["refreshing"] = False


def parse_ipconfig(output: str) -> List[Dict[str, str]]:
    """Adapter names and IPv4 addresses from Windows `ipconfig` output."""
    rows: List[Dict[str, str]] = []
    name = ""
    for line in output.splitlines():
        if line and not line[0].isspace() and line.rstrip().endswith(":"):
            header = line.rstrip()[:-1]
            name = header.split(" adapter ", 1)[1] if " adapter " in header else header
        elif "IPv4" in line and ":" in line:
            ip = line.split(":", 1)[1].strip().split("(")[0].strip()
            if name and ip:
                rows.append({"name": name, "ip": ip})
    return rows


def _ipconfig_interfaces() -> List[Dict[str, str]]:
    out = subprocess.check_output(
        ["ipconfig"], text=True, timeout=15, stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW, errors="replace",
    )
    return parse_ipconfig(out)


def _scan_local_addresses() -> List[Dict[str, Any]]:
    rows: List[Dict[str, str]] = []
    if sys.platform == "win32":
        for source in (_windows_interfaces, _ipconfig_interfaces):
            try:
                rows = source()
            except Exception as e:
                print(f"[remote-access] Could not list interfaces via {source.__name__}: {e}")
                rows = []
            if rows:
                break
    if not rows:
        # Last resort: addresses without adapter names (so none can be marked primary).
        try:
            ips = {ai[4][0] for ai in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
            rows = [{"name": "", "ip": ip} for ip in sorted(ips)]
        except OSError:
            rows = []

    result = []
    for row in rows:
        ip = row["ip"]
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if addr.is_loopback or addr.is_link_local:
            continue
        name = row["name"]
        lowered = name.lower()
        result.append({
            "name": name,
            "ip": ip,
            # Physical office-network adapters first; virtual/VPN adapters after.
            "primary": lowered.startswith(("wi-fi", "wifi", "ethernet", "wlan", "eth")),
        })
    result.sort(key=lambda r: (not r["primary"], r["name"].lower()))
    return result
