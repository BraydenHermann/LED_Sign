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


def _allowed_networks() -> List[ipaddress._BaseNetwork]:
    try:
        mtime = os.path.getmtime(CONFIG_FILE)
    except OSError:
        mtime = None
    with _lock:
        if _cache["mtime"] != mtime:
            networks = []
            for entry in get_allowed_entries():
                try:
                    networks.append(parse_entry(entry))
                except ValueError:
                    print(f"[remote-access] Ignoring invalid allowlist entry: {entry!r}")
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
    return any(addr in net for net in _allowed_networks() if net.version == addr.version)


def get_recent_denied() -> List[Dict[str, Any]]:
    """Recently refused devices that are still not allowed."""
    try:
        with open(DENIED_FILE, "r", encoding="utf-8") as f:
            rows = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(rows, list):
        return []
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        ip = normalize_ip(str(row.get("ip") or ""))
        if ip and not is_allowed(ip):
            result.append({"ip": ip, "last_seen": row.get("last_seen")})
    return result


def set_allowed_entries(entries: List[str]) -> List[str]:
    cleaned: List[str] = []
    for entry in entries:
        entry = str(entry).strip()
        if not entry:
            continue
        net = parse_entry(entry)  # raises ValueError on bad input
        text = str(net.network_address) if net.num_addresses == 1 else str(net)
        if text not in cleaned:
            cleaned.append(text)
    tmp = CONFIG_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"allowed_ips": cleaned}, f, indent=2)
    os.replace(tmp, CONFIG_FILE)
    return cleaned


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
