"""
Google Chat notifications for the LED Sign remote link.

Remote devices reach LED Sign at this computer's office-network address over
the work VPN. That address can change when the computer reconnects, so a
background watcher posts the new link to a Google Chat webhook whenever it
changes (when auto-send is on).
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional

import remote_access

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
WEBHOOK_FILE = os.path.join(SERVER_DIR, ".remote_access_webhook.json")
# Settings saved by the old Cloudflare tunnel feature; migrated on first read.
LEGACY_WEBHOOK_FILE = os.path.join(SERVER_DIR, ".tunnel_webhook")

UI_PORT = 5173
WEBHOOK_PREFIX = "https://chat.googleapis.com/"
CHECK_INTERVAL_SECONDS = 60
PRITUNL_INSTALL_URL = "https://client.pritunl.com/#install"

_config_lock = threading.Lock()
_send_lock = threading.Lock()
_watcher_started = False


def _default_config() -> Dict[str, Any]:
    # last_sent_link: shown in the UI. known_link: what the watcher compares against
    # (the last link sent, or the link it saw first, so startup never posts by itself).
    return {"webhook_url": "", "auto_send": False, "last_sent_link": "", "known_link": ""}


def _read_json(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
    except OSError:
        return None
    if not raw:
        return {}
    if not raw.startswith("{"):
        return {"webhook_url": raw}  # very old format: bare URL
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def get_config() -> Dict[str, Any]:
    with _config_lock:
        data = _read_json(WEBHOOK_FILE)
        if data is None:
            legacy = _read_json(LEGACY_WEBHOOK_FILE) or {}
            # Keep the webhook and auto-send choice; the old tunnel link is meaningless now.
            data = {"webhook_url": legacy.get("webhook_url", ""), "auto_send": legacy.get("auto_send", False)}
        cfg = _default_config()
        cfg["webhook_url"] = str(data.get("webhook_url") or "").strip()
        cfg["auto_send"] = bool(data.get("auto_send", False))
        cfg["last_sent_link"] = str(data.get("last_sent_link") or "").strip()
        cfg["known_link"] = str(data.get("known_link") or "").strip()
        return cfg


def _write_config(cfg: Dict[str, Any]):
    tmp = WEBHOOK_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, WEBHOOK_FILE)


def set_config(webhook_url: Optional[str] = None, auto_send: Optional[bool] = None,
               last_sent_link: Optional[str] = None, known_link: Optional[str] = None,
               clear_webhook: bool = False) -> Dict[str, Any]:
    cfg = get_config()
    if clear_webhook:
        cfg["webhook_url"] = ""
        cfg["auto_send"] = False
    elif webhook_url is not None:
        cleaned = webhook_url.strip()
        if cleaned and not cleaned.startswith("•"):  # masked value from the UI = unchanged
            if not cleaned.startswith(WEBHOOK_PREFIX):
                raise ValueError(f"Google Chat webhook URLs start with {WEBHOOK_PREFIX}")
            cfg["webhook_url"] = cleaned
    if auto_send is not None and not clear_webhook:
        cfg["auto_send"] = bool(auto_send)
    if last_sent_link is not None:
        cfg["last_sent_link"] = last_sent_link
    if known_link is not None:
        cfg["known_link"] = known_link
    with _config_lock:
        _write_config(cfg)
    return cfg


def get_public_config() -> Dict[str, Any]:
    """Config safe to show in the browser: the webhook URL contains a secret key."""
    cfg = get_config()
    url = cfg["webhook_url"]
    masked = ("•" * 24 + url[-6:]) if len(url) > 6 else ("•" * len(url))
    return {
        "has_webhook": bool(url),
        "masked_webhook_url": masked,
        "auto_send": cfg["auto_send"],
        "last_sent_link": cfg["last_sent_link"],
    }


def link_for(addresses) -> str:
    """The link remote devices should open: this computer's office-network address."""
    addresses = list(addresses or [])
    main = next((a for a in addresses if a.get("primary")), None)
    return f"http://{main['ip']}:{UI_PORT}/" if main else ""


def current_link(fresh: bool = False) -> str:
    if fresh:
        addresses = remote_access._refresh_addresses()
    else:
        addresses = remote_access.list_local_addresses()
    return link_for(addresses)


def _message(link: str, changed: bool) -> str:
    heading = "*LED Sign link changed*" if changed else "*LED Sign remote link*"
    return (
        f"{heading}\n\n<{link}>\n\n"
        f"Connect to the work VPN with <{PRITUNL_INSTALL_URL}|Pritunl> first, then open the link."
    )


def send_link(link: Optional[str] = None, changed: bool = False) -> Dict[str, Any]:
    cfg = get_config()
    if not cfg["webhook_url"]:
        return {"success": False, "error": "Add a Google Chat webhook URL first."}
    link = link or current_link()
    if not link:
        return {"success": False, "error": "This computer has no office-network (Wi-Fi/Ethernet) address right now."}

    payload = json.dumps({"text": _message(link, changed)}).encode("utf-8")
    req = urllib.request.Request(
        cfg["webhook_url"], data=payload, method="POST",
        headers={"Content-Type": "application/json; charset=UTF-8"},
    )
    with _send_lock:
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                if not 200 <= resp.status < 300:
                    return {"success": False, "error": f"Google Chat returned HTTP {resp.status}"}
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8", errors="ignore")[:300]
            except Exception:
                body = ""
            return {"success": False, "error": f"Google Chat error (HTTP {e.code}) {body}".strip()}
        except Exception as e:
            return {"success": False, "error": f"Could not reach Google Chat: {e}"}
        set_config(last_sent_link=link, known_link=link)
    return {"success": True, "link": link}


def check_and_notify(state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """One watcher tick. A new link must be seen on two checks in a row before
    it is sent, so a brief Wi-Fi reconnect doesn't post a burst of messages."""
    link = current_link(fresh=True)
    if not link:
        state["candidate"] = ""
        return None
    cfg = get_config()
    if not cfg["known_link"]:
        set_config(known_link=link)  # first sighting: remember it, don't post
        state["candidate"] = ""
        return None
    if link == cfg["known_link"] or not (cfg["auto_send"] and cfg["webhook_url"]):
        state["candidate"] = ""
        return None
    if state.get("candidate") != link:
        state["candidate"] = link
        return None
    result = send_link(link, changed=True)
    print(f"[remote-link] Sent new link {link} to Google Chat: {result.get('success')} {result.get('error') or ''}".rstrip())
    if result.get("success"):
        state["candidate"] = ""
    return result


def _watch_loop():
    state: Dict[str, Any] = {"candidate": ""}
    while True:
        try:
            check_and_notify(state)
        except Exception as e:
            print(f"[remote-link] Watcher error: {e}")
        time.sleep(CHECK_INTERVAL_SECONDS)


def start_watcher():
    global _watcher_started
    if _watcher_started:
        return
    _watcher_started = True
    threading.Thread(target=_watch_loop, daemon=True, name="remote-link-watcher").start()
