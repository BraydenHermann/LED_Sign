"""
Cloudflare Tunnel service for LED Sign.
Provides secure, dynamic remote access via Cloudflare Quick Tunnels
for any user running this program.
"""
import os
import re
import sys
import time
import shutil
import json
import urllib.request
import urllib.error
import subprocess
import threading
import secrets
from typing import Optional, Dict, Any

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TUNNEL_LOG = os.path.join(BASE_DIR, "tunnel.log")
TOKEN_FILE = os.path.join(BASE_DIR, "server", ".tunnel_token")
WEBHOOK_FILE = os.path.join(BASE_DIR, "server", ".tunnel_webhook")
GENERATED_AT_FILE = os.path.join(BASE_DIR, "server", ".tunnel_generated_at")
GOOGLE_SESSIONS_FILE = os.path.join(BASE_DIR, "server", ".tunnel_google_sessions")

# Automatically rotate the remote access link after 7 days
LINK_EXPIRY_SECONDS = 7 * 24 * 60 * 60

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0

DOWNLOAD_URLS = {
    "win32": "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe",
    "darwin": "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64",
    "linux": "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
}


class TunnelService:
    def __init__(self):
        self._lock = threading.Lock()
        self._webhook_send_lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._cached_url: Optional[str] = None
        self._is_downloading = False
        self._is_regenerating = False
        self._error_message: Optional[str] = None
        self._start_time: float = 0.0
        self._generated_at: Optional[float] = None
        self._google_sessions: Dict[str, Dict[str, Any]] = self._load_google_sessions()
        self._google_challenges: Dict[str, Dict[str, Any]] = {}
        threading.Thread(target=self._expiry_watchdog_loop, daemon=True).start()

    def get_binary_path(self) -> Optional[str]:
        exe_name = "cloudflared.exe" if sys.platform == "win32" else "cloudflared"
        local_path = os.path.join(BASE_DIR, exe_name)
        if os.path.exists(local_path):
            return local_path
        which_path = shutil.which("cloudflared")
        if which_path:
            return which_path
        return None

    def _download_binary(self):
        with self._lock:
            if self._is_downloading:
                return
            self._is_downloading = True
            self._error_message = None

        def _do_download():
            try:
                url = DOWNLOAD_URLS.get(sys.platform, DOWNLOAD_URLS["linux"])
                exe_name = "cloudflared.exe" if sys.platform == "win32" else "cloudflared"
                dest_path = os.path.join(BASE_DIR, exe_name)
                temp_path = dest_path + ".tmp"
                print(f"[tunnel] Downloading cloudflared from {url}...")
                urllib.request.urlretrieve(url, temp_path)
                if sys.platform != "win32":
                    os.chmod(temp_path, 0o755)
                os.replace(temp_path, dest_path)
                print(f"[tunnel] cloudflared downloaded successfully to {dest_path}")
                self._start_tunnel()
            except Exception as e:
                print(f"[tunnel] Failed to download cloudflared: {e}")
                with self._lock:
                    self._error_message = f"Download failed: {e}"
            finally:
                with self._lock:
                    self._is_downloading = False

        threading.Thread(target=_do_download, daemon=True).start()

    def _extract_url_from_log(self) -> Optional[str]:
        if not os.path.exists(TUNNEL_LOG):
            return None
        try:
            with open(TUNNEL_LOG, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            matches = re.findall(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", content)
            if matches:
                # Return the latest one if multiple exist
                return matches[-1]
        except Exception:
            pass
        return None

    def _is_process_alive(self) -> bool:
        if self._process is not None:
            if self._process.poll() is None:
                return True
            self._process = None
        # Check system processes for cloudflared
        try:
            if sys.platform == "win32":
                kwargs = {"creationflags": CREATE_NO_WINDOW} if CREATE_NO_WINDOW else {}
                res = subprocess.run(
                    ["tasklist", "/FI", "IMAGENAME eq cloudflared.exe", "/NH"],
                    capture_output=True,
                    text=True,
                    timeout=2,
                    **kwargs
                )
                return "cloudflared.exe" in res.stdout
            else:
                res = subprocess.run(
                    ["pgrep", "-f", "cloudflared"],
                    capture_output=True,
                    text=True,
                    timeout=2
                )
                return len(res.stdout.strip()) > 0
        except Exception:
            return False

    def _kill_all_cloudflared(self):
        """Terminate our tracked process and any orphaned cloudflared processes."""
        if self._process is not None:
            try:
                self._process.terminate()
                self._process.wait(timeout=2)
            except Exception:
                try:
                    self._process.kill()
                except Exception:
                    pass
            self._process = None

        try:
            if sys.platform == "win32":
                kwargs = {"creationflags": CREATE_NO_WINDOW} if CREATE_NO_WINDOW else {}
                subprocess.run(
                    ["taskkill", "/F", "/IM", "cloudflared.exe", "/T"],
                    capture_output=True,
                    timeout=3,
                    **kwargs
                )
                for _ in range(10):
                    res = subprocess.run(
                        ["tasklist", "/FI", "IMAGENAME eq cloudflared.exe", "/NH"],
                        capture_output=True,
                        text=True,
                        timeout=2,
                        **kwargs
                    )
                    if "cloudflared.exe" not in res.stdout:
                        break
                    time.sleep(0.2)
            else:
                subprocess.run(["pkill", "-9", "-f", "cloudflared"], capture_output=True, timeout=3)
        except Exception:
            pass

    def _start_tunnel(self):
        binary = self.get_binary_path()
        if not binary:
            self._download_binary()
            return

        if self._is_process_alive():
            url = self._extract_url_from_log()
            if url:
                self._cached_url = url
                return

        with self._lock:
            # Ensure no orphaned cloudflared processes remain before starting a new tunnel
            self._kill_all_cloudflared()

            # Clear old log before starting
            try:
                if os.path.exists(TUNNEL_LOG):
                    os.remove(TUNNEL_LOG)
            except Exception:
                pass

            try:
                cmd = [
                    binary,
                    "tunnel",
                    "--url", "http://localhost:5173",
                    "--logfile", TUNNEL_LOG,
                    "--no-autoupdate"
                ]
                kwargs = {}
                if sys.platform == "win32":
                    kwargs["creationflags"] = CREATE_NO_WINDOW | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

                self._process = subprocess.Popen(cmd, **kwargs)
                self._start_time = time.monotonic()
                self._set_generated_at(time.time())
                print(f"[tunnel] Started cloudflared tunnel process (PID {self._process.pid})")
                if not self._is_regenerating:
                    threading.Thread(target=self._auto_send_when_ready, daemon=True).start()
            except Exception as e:
                self._error_message = f"Failed to start tunnel: {e}"
                print(f"[tunnel] Error starting tunnel: {e}")

    def _auto_send_when_ready(self):
        """Wait for a newly started tunnel to report its URL and auto-send to Google Chat if enabled."""
        for _ in range(30):
            time.sleep(0.5)
            url = self._extract_url_from_log()
            if url:
                with self._webhook_send_lock:
                    token = self.get_token()
                    secure_url = f"{url}/?token={token}"
                    cfg = self.get_webhook_config()
                    if cfg.get("auto_send") and cfg.get("webhook_url") and cfg.get("last_sent_url") != secure_url:
                        self.send_google_chat_webhook(cfg["webhook_url"])
                break

    def get_token(self) -> str:
        if os.path.exists(TOKEN_FILE):
            try:
                with open(TOKEN_FILE, "r", encoding="utf-8") as f:
                    tok = f.read().strip()
                    if len(tok) >= 16:
                        return tok
            except Exception:
                pass
        new_tok = secrets.token_urlsafe(24)
        try:
            with open(TOKEN_FILE, "w", encoding="utf-8") as f:
                f.write(new_tok)
        except Exception:
            pass
        return new_tok

    def get_status(self) -> Dict[str, Any]:
        binary = self.get_binary_path()
        if not binary and not self._is_downloading:
            self._download_binary()
            return {
                "status": "downloading",
                "url": None,
                "active": False,
                "message": "Downloading Cloudflare tunnel agent..."
            }

        if self._is_downloading:
            return {
                "status": "downloading",
                "url": None,
                "active": False,
                "message": "Downloading Cloudflare tunnel agent..."
            }

        if not self._is_process_alive():
            self._start_tunnel()
            return {
                "status": "starting",
                "url": None,
                "active": False,
                "message": "Starting Cloudflare tunnel..."
            }

        url = self._extract_url_from_log()
        if url:
            if self._cached_url != url or self._generated_at is None:
                self._cached_url = url
                self._ensure_generated_at()
            if self.is_link_expired() and not self._is_regenerating:
                print("[tunnel] Remote link reached 7-day limit during status check; rotating link...")
                threading.Thread(target=self.regenerate_link, daemon=True).start()
                return {
                    "status": "starting",
                    "url": None,
                    "active": False,
                    "message": "Rotating expired 7-day remote link..."
                }
            token = self.get_token()
            secure_url = f"{url}/?token={token}"
            gen_at = self.get_generated_at()
            return {
                "status": "ready",
                "url": secure_url,
                "raw_url": url,
                "token": token,
                "generated_at": gen_at,
                "expires_at": gen_at + LINK_EXPIRY_SECONDS,
                "active": True,
                "message": "Secure Cloudflare tunnel is active"
            }

        return {
            "status": "starting",
            "url": None,
            "active": False,
            "message": "Establishing secure Cloudflare connection..."
        }

    def is_link_expired(self) -> bool:
        self._ensure_generated_at()
        if not self._generated_at:
            return False
        return (time.time() - self._generated_at) >= LINK_EXPIRY_SECONDS

    def _expiry_watchdog_loop(self):
        """Background daemon that automatically generates a new remote link after 7 days."""
        while True:
            time.sleep(30)
            try:
                if not self._is_downloading and not self._is_regenerating and self._is_process_alive():
                    if self.is_link_expired():
                        print("[tunnel] Remote link is 7 days old. Automatically generating a new link...")
                        self.regenerate_link()
            except Exception as e:
                print(f"[tunnel] Expiry watchdog error: {e}")

    def _load_google_sessions(self) -> Dict[str, Dict[str, Any]]:
        if os.path.exists(GOOGLE_SESSIONS_FILE):
            try:
                with open(GOOGLE_SESSIONS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    return data
            except Exception:
                pass
        return {}

    def _save_google_sessions(self):
        try:
            with open(GOOGLE_SESSIONS_FILE, "w", encoding="utf-8") as f:
                json.dump(self._google_sessions, f)
        except Exception:
            pass

    def clear_google_sessions(self):
        self._google_sessions = {}
        self._google_challenges = {}
        try:
            if os.path.exists(GOOGLE_SESSIONS_FILE):
                os.remove(GOOGLE_SESSIONS_FILE)
        except Exception:
            pass

    def create_google_session(self, email: str) -> str:
        session_tok = secrets.token_urlsafe(32)
        now = time.time()
        self._google_sessions[session_tok] = {
            "email": email.strip().lower(),
            "tunnel_token": self.get_token(),
            "created_at": now,
        }
        self._save_google_sessions()
        return session_tok

    def verify_google_session(self, session_tok: Optional[str]) -> Optional[str]:
        """Return the authenticated Google email if the session token is valid for the current non-expired link."""
        if not session_tok:
            return None
        if self.is_link_expired():
            return None
        info = self._google_sessions.get(session_tok.strip())
        if not info or not isinstance(info, dict):
            return None
        if info.get("tunnel_token") != self.get_token():
            return None
        created_at = float(info.get("created_at") or 0)
        if (time.time() - created_at) >= LINK_EXPIRY_SECONDS:
            self._google_sessions.pop(session_tok.strip(), None)
            self._save_google_sessions()
            return None
        return info.get("email")

    def create_google_challenge(self) -> str:
        now = time.time()
        stale = [k for k, v in self._google_challenges.items() if now - v.get("created_at", 0) > 600]
        for k in stale:
            self._google_challenges.pop(k, None)
        cid = secrets.token_urlsafe(24)
        self._google_challenges[cid] = {
            "status": "pending",
            "created_at": now,
        }
        return cid

    def complete_google_challenge(self, cid: str, email: str) -> str:
        session_tok = self.create_google_session(email)
        self._google_challenges[cid] = {
            "status": "authenticated",
            "session_token": session_tok,
            "email": email,
            "created_at": time.time(),
        }
        return session_tok

    def fail_google_challenge(self, cid: str, error_msg: str):
        self._google_challenges[cid] = {
            "status": "error",
            "error": error_msg,
            "created_at": time.time(),
        }

    def get_google_challenge(self, cid: str) -> Dict[str, Any]:
        return self._google_challenges.get(cid, {"status": "not_found"})

    def create_chat_verification_code(self, owner_email: Optional[str] = None) -> Dict[str, Any]:
        """Generate a 6-digit one-time verification code and send it to Google Chat."""
        if self.is_link_expired():
            return {"success": False, "error": "This remote access link has expired."}

        target_webhook = self.get_webhook_url()
        if not target_webhook:
            return {"success": False, "error": "No Google Chat webhook URL is configured on the host."}

        now = time.time()
        stale = [k for k, v in self._google_challenges.items() if now - v.get("created_at", 0) > 600]
        for k in stale:
            self._google_challenges.pop(k, None)

        cid = secrets.token_urlsafe(16)
        code = f"{secrets.randbelow(1000000):06d}"
        self._google_challenges[cid] = {
            "type": "chat_code",
            "code": code,
            "attempts": 0,
            "owner_email": (owner_email or "google-chat-verified").strip().lower(),
            "created_at": now,
        }

        msg = (
            f"🔐 *LED Sign Verification Code*\n\n"
            f"`{code}`\n\n"
            f"Enter this 6-digit code to unlock your remote LED Sign dashboard.\n"
            f"_Expires in 10 minutes._"
        )
        res = self.send_google_chat_webhook(target_webhook, message=msg, is_verification_code=True)
        if not res.get("success"):
            self._google_challenges.pop(cid, None)
            return {"success": False, "error": res.get("error") or "Failed to send verification code to Google Chat."}

        return {"success": True, "challenge_id": cid, "expires_in": 600}

    def verify_chat_verification_code(self, cid: str, submitted_code: str) -> Dict[str, Any]:
        """Verify a 6-digit Google Chat code and issue a remote session token."""
        if self.is_link_expired():
            return {"success": False, "error": "This remote access link has expired."}

        entry = self._google_challenges.get(cid)
        if not entry or entry.get("type") != "chat_code":
            return {"success": False, "error": "Verification code expired or not found. Please request a new code."}

        if time.time() - float(entry.get("created_at", 0)) > 600:
            self._google_challenges.pop(cid, None)
            return {"success": False, "error": "Verification code expired. Please request a new code."}

        cleaned = re.sub(r"\D", "", (submitted_code or "").strip())
        if len(cleaned) != 6:
            return {"success": False, "error": "Please enter the 6-digit verification code."}

        entry["attempts"] = int(entry.get("attempts", 0)) + 1
        if secrets.compare_digest(cleaned, str(entry["code"])):
            email = entry.get("owner_email") or "google-chat-verified"
            self._google_challenges.pop(cid, None)
            session_tok = self.create_google_session(email)
            return {"success": True, "session_token": session_tok, "email": email}

        if entry["attempts"] >= 5:
            self._google_challenges.pop(cid, None)
            return {"success": False, "error": "Too many incorrect attempts. Please request a new code."}

        remaining = 5 - entry["attempts"]
        return {"success": False, "error": f"Incorrect code. {remaining} attempt{'s' if remaining != 1 else ''} remaining."}

    def _set_generated_at(self, ts: float):
        self._generated_at = ts
        try:
            with open(GENERATED_AT_FILE, "w", encoding="utf-8") as f:
                f.write(str(ts))
        except Exception:
            pass

    def _ensure_generated_at(self):
        if self._generated_at is not None:
            return
        if os.path.exists(GENERATED_AT_FILE):
            try:
                with open(GENERATED_AT_FILE, "r", encoding="utf-8") as f:
                    self._generated_at = float(f.read().strip())
                    return
            except Exception:
                pass
        if os.path.exists(TUNNEL_LOG):
            try:
                self._generated_at = os.path.getmtime(TUNNEL_LOG)
                self._set_generated_at(self._generated_at)
                return
            except Exception:
                pass
        self._set_generated_at(time.time())

    def get_generated_at(self) -> float:
        self._ensure_generated_at()
        return self._generated_at or time.time()

    def get_webhook_config(self) -> Dict[str, Any]:
        if os.path.exists(WEBHOOK_FILE):
            try:
                with open(WEBHOOK_FILE, "r", encoding="utf-8") as f:
                    raw = f.read().strip()
                if not raw:
                    return {"webhook_url": "", "auto_send": False, "last_sent_url": ""}
                if raw.startswith("{"):
                    data = json.loads(raw)
                    return {
                        "webhook_url": str(data.get("webhook_url") or "").strip(),
                        "auto_send": bool(data.get("auto_send", False)),
                        "last_sent_url": str(data.get("last_sent_url") or "").strip(),
                    }
                return {"webhook_url": raw, "auto_send": False, "last_sent_url": ""}
            except Exception:
                pass
        return {"webhook_url": "", "auto_send": False, "last_sent_url": ""}

    def get_public_webhook_config(self) -> Dict[str, Any]:
        cfg = self.get_webhook_config()
        url = cfg["webhook_url"]
        if len(url) > 6:
            masked = ("•" * 24) + url[-6:]
        elif url:
            masked = "•" * len(url)
        else:
            masked = ""
        return {
            "has_webhook": bool(url),
            "masked_webhook_url": masked,
            "auto_send": cfg["auto_send"]
        }

    def get_webhook_url(self) -> str:
        return self.get_webhook_config()["webhook_url"]

    def set_webhook_config(self, webhook_url: Optional[str] = None, auto_send: Optional[bool] = None, last_sent_url: Optional[str] = None, clear_webhook: bool = False):
        cfg = self.get_webhook_config()
        if clear_webhook:
            cfg["webhook_url"] = ""
            cfg["auto_send"] = False
        elif webhook_url is not None:
            cleaned = webhook_url.strip()
            if cleaned and not cleaned.startswith("•"):
                cfg["webhook_url"] = cleaned
        if auto_send is not None and not clear_webhook:
            cfg["auto_send"] = bool(auto_send)
        if last_sent_url is not None:
            cfg["last_sent_url"] = last_sent_url
        try:
            with open(WEBHOOK_FILE, "w", encoding="utf-8") as f:
                json.dump(cfg, f)
        except Exception:
            pass

    def set_webhook_url(self, url: str):
        self.set_webhook_config(webhook_url=url)

    def regenerate_link(self) -> Dict[str, Any]:
        """Stop current tunnel, generate a new cryptographic token, and start a fresh tunnel with a new URL."""
        self._is_regenerating = True
        try:
            with self._lock:
                # 1. Stop current process and any orphaned cloudflared processes
                self._kill_all_cloudflared()

                # 2. Invalidate cached URL, timestamp, log, and existing Google sessions
                self._cached_url = None
                self._generated_at = None
                self.clear_google_sessions()
                for path in (TUNNEL_LOG, GENERATED_AT_FILE):
                    try:
                        if os.path.exists(path):
                            os.remove(path)
                    except Exception:
                        pass

                # 3. Generate a brand new high-entropy token
                new_tok = secrets.token_urlsafe(24)
                try:
                    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
                        f.write(new_tok)
                except Exception:
                    pass

            # 4. Start fresh tunnel
            self._start_tunnel()

            # Wait up to 10 seconds for the new tunnel URL to be established and extracted
            status = self.get_status()
            for _ in range(20):
                if status.get("url"):
                    break
                time.sleep(0.5)
                status = self.get_status()

            if status.get("url"):
                self._set_generated_at(time.time())
                status["generated_at"] = self._generated_at
                status["expires_at"] = self._generated_at + LINK_EXPIRY_SECONDS
                cfg = self.get_webhook_config()
                if cfg["auto_send"] and cfg["webhook_url"]:
                    res = self.send_google_chat_webhook(cfg["webhook_url"])
                    status["webhook_status"] = "sent" if res.get("success") else "error"
            return status
        finally:
            self._is_regenerating = False

    def send_google_chat_webhook(self, webhook_url: Optional[str] = None, message: Optional[str] = None, is_verification_code: bool = False) -> Dict[str, Any]:
        """Send the current remote access link (or verification code) to a Google Chat webhook safely."""
        url = None
        if not is_verification_code:
            status = self.get_status()
            url = status.get("url")
            if not url:
                return {"success": False, "error": "No active remote access link available to send"}

        raw_input = (webhook_url or "").strip()
        if raw_input.startswith("•"):
            raw_input = ""
        target_webhook = raw_input or self.get_webhook_url()
        if not target_webhook:
            return {"success": False, "error": "No Google Chat webhook URL provided"}

        if not target_webhook.startswith("https://chat.googleapis.com/"):
            return {"success": False, "error": "Invalid Google Chat webhook URL. Must start with https://chat.googleapis.com/"}

        # Remember webhook URL
        self.set_webhook_config(webhook_url=target_webhook)

        gen_ts = self.get_generated_at()
        timestamp_str = time.strftime("%Y-%m-%d %I:%M:%S %p", time.localtime(gen_ts))
        text = message or f"🔒 *LED Sign Remote Access Link*\n\nAccess your sign dashboard securely:\n<{url}>\n\n_Generated: {timestamp_str}_"

        payload = json.dumps({"text": text}).encode("utf-8")
        req = urllib.request.Request(
            target_webhook,
            data=payload,
            headers={"Content-Type": "application/json; charset=UTF-8"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                if 200 <= resp.status < 300:
                    if not is_verification_code and url:
                        self.set_webhook_config(last_sent_url=url)
                    return {"success": True, "message": "Link sent to Google Chat successfully!"}
                return {"success": False, "error": f"Google Chat returned status HTTP {resp.status}"}
        except urllib.error.HTTPError as e:
            try:
                err_body = e.read().decode("utf-8", errors="ignore")
            except Exception:
                err_body = str(e)
            return {"success": False, "error": f"Google Chat error (HTTP {e.code}): {err_body}"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    def stop(self):
        with self._lock:
            self._kill_all_cloudflared()
            self._cached_url = None


tunnel_service = TunnelService()
