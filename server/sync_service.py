"""Cross-device sync through the signed-in Google account's Drive app folder.

The browser owns merging (it holds the presets and settings). This module only
stores and fetches files in Drive's hidden per-app folder, which only LED
Sign's OAuth client can read, and syncs the server-side LOY SPACE session.

Layout in the app folder:
  manifest.json          index of every synced item with its updatedAt time
  preset-<hash>.json     one file per preset, so a change uploads one preset
"""
import hashlib
import io
import json
import os
import threading
from typing import Dict, Iterable, Optional

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload

DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata"
MANIFEST_NAME = "manifest.json"
LOY_SESSION_KEY = "loySession"


class SyncUnavailable(Exception):
    """Drive cannot be used yet; `reason` tells the UI what the user must do."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason


def preset_file_name(preset_id: str) -> str:
    # Preset ids are free-form; hash them into a safe, stable file name.
    return "preset-" + hashlib.sha1(str(preset_id).encode("utf-8")).hexdigest() + ".json"


class DriveSync:
    def __init__(self, calendar_service, loy_session_path: str):
        self.calendar_service = calendar_service
        self.loy_session_path = loy_session_path
        self._lock = threading.Lock()

    # -- Drive plumbing -------------------------------------------------------

    def _drive(self):
        service = self.calendar_service
        if not service.creds:
            raise SyncUnavailable("signed_out", "Sign in with Google to sync between devices.")
        try:
            if not service.creds.valid:
                service._ensure_valid()
        except Exception as err:
            raise SyncUnavailable("signed_out", f"Google sign-in expired: {err}")
        return build("drive", "v3", credentials=service.creds, cache_discovery=False)

    @staticmethod
    def _translate(err: HttpError) -> SyncUnavailable:
        text = str(err)
        if err.resp.status in (401, 403) and ("insufficient" in text.lower() or "scope" in text.lower()):
            return SyncUnavailable("needs_permission", "Sign in with Google again to allow LED Sign to store its sync data in Drive.")
        if err.resp.status == 403 and ("accessNotConfigured" in text or "has not been used" in text or "disabled" in text):
            return SyncUnavailable("api_disabled", "Enable the Google Drive API for this app's Google Cloud project.")
        return SyncUnavailable("error", f"Google Drive error: {err}")

    def _file_ids(self, drive) -> Dict[str, str]:
        ids: Dict[str, str] = {}
        token = None
        while True:
            result = drive.files().list(
                spaces="appDataFolder", fields="nextPageToken, files(id, name)",
                pageSize=1000, pageToken=token,
            ).execute()
            for f in result.get("files", []):
                ids[f["name"]] = f["id"]
            token = result.get("nextPageToken")
            if not token:
                return ids

    @staticmethod
    def _read_json(drive, file_id: str):
        buffer = io.BytesIO()
        downloader = MediaIoBaseDownload(buffer, drive.files().get_media(fileId=file_id))
        done = False
        while not done:
            _, done = downloader.next_chunk()
        return json.loads(buffer.getvalue().decode("utf-8"))

    @staticmethod
    def _write_json(drive, ids: Dict[str, str], name: str, data):
        media = MediaIoBaseUpload(io.BytesIO(json.dumps(data).encode("utf-8")), mimetype="application/json", resumable=False)
        if name in ids:
            drive.files().update(fileId=ids[name], media_body=media).execute()
        else:
            created = drive.files().create(
                body={"name": name, "parents": ["appDataFolder"]}, media_body=media, fields="id",
            ).execute()
            ids[name] = created["id"]

    # -- LOY SPACE session (kept on the server, not in the browser) ----------

    def _local_loy_session(self) -> Optional[dict]:
        if not os.path.exists(self.loy_session_path):
            return None
        try:
            with open(self.loy_session_path, "r", encoding="utf-8") as f:
                value = json.load(f)
            return {"value": value, "updatedAt": int(os.path.getmtime(self.loy_session_path) * 1000)}
        except (OSError, ValueError):
            return None

    def _apply_remote_loy_session(self, manifest: dict):
        remote = (manifest.get("secrets") or {}).get(LOY_SESSION_KEY)
        value = (remote or {}).get("value")
        if not remote or not isinstance(value, dict) or not (value.get("userid") and value.get("key")):
            return
        local = self._local_loy_session()
        if local and local["updatedAt"] >= remote.get("updatedAt", 0):
            return
        with open(self.loy_session_path, "w", encoding="utf-8") as f:
            json.dump(value, f, indent=2)
        stamp = remote.get("updatedAt", 0) / 1000
        os.utime(self.loy_session_path, (stamp, stamp))

    def _include_local_loy_session(self, manifest: dict):
        local = self._local_loy_session()
        if not local:
            return
        secrets = manifest.setdefault("secrets", {})
        remote = secrets.get(LOY_SESSION_KEY)
        if not remote or local["updatedAt"] > remote.get("updatedAt", 0):
            secrets[LOY_SESSION_KEY] = local

    # -- Public API -----------------------------------------------------------

    def get_manifest(self) -> dict:
        """Return the stored manifest (empty when nothing synced yet)."""
        with self._lock:
            drive = self._drive()
            try:
                ids = self._file_ids(drive)
                manifest = self._read_json(drive, ids[MANIFEST_NAME]) if MANIFEST_NAME in ids else {}
            except HttpError as err:
                raise self._translate(err)
            self._apply_remote_loy_session(manifest)
            stored_session = (manifest.get("secrets") or {}).get(LOY_SESSION_KEY)
            self._include_local_loy_session(manifest)
            # A sign-in made on this machine must reach Drive even when the
            # browser has nothing else to upload.
            needs_push = (manifest.get("secrets") or {}).get(LOY_SESSION_KEY) is not stored_session
            # The browser never needs the LOY session itself.
            secrets = dict(manifest.get("secrets") or {})
            if LOY_SESSION_KEY in secrets:
                secrets[LOY_SESSION_KEY] = {"updatedAt": secrets[LOY_SESSION_KEY].get("updatedAt", 0)}
            return {**manifest, "secrets": secrets, "needsPush": needs_push}

    def get_presets(self, preset_ids: Iterable[str]) -> Dict[str, dict]:
        with self._lock:
            drive = self._drive()
            try:
                ids = self._file_ids(drive)
                found = {}
                for preset_id in preset_ids:
                    name = preset_file_name(preset_id)
                    if name in ids:
                        found[preset_id] = self._read_json(drive, ids[name])
                return found
            except HttpError as err:
                raise self._translate(err)

    def push(self, manifest: dict, presets: Dict[str, dict]):
        """Store changed presets, remove deleted ones, then the manifest."""
        with self._lock:
            drive = self._drive()
            try:
                ids = self._file_ids(drive)
                for preset_id, preset in presets.items():
                    self._write_json(drive, ids, preset_file_name(preset_id), preset)
                for preset_id, entry in (manifest.get("presets") or {}).items():
                    name = preset_file_name(preset_id)
                    if entry.get("deleted") and name in ids:
                        drive.files().delete(fileId=ids.pop(name)).execute()
                # The browser only knows the session's timestamp; keep the
                # stored session value and refresh it from this machine.
                stored = self._read_json(drive, ids[MANIFEST_NAME]) if MANIFEST_NAME in ids else {}
                secrets = dict(manifest.get("secrets") or {})
                stored_session = (stored.get("secrets") or {}).get(LOY_SESSION_KEY)
                if stored_session:
                    secrets[LOY_SESSION_KEY] = stored_session
                else:
                    secrets.pop(LOY_SESSION_KEY, None)
                manifest = {**manifest, "secrets": secrets}
                self._include_local_loy_session(manifest)
                self._write_json(drive, ids, MANIFEST_NAME, manifest)
            except HttpError as err:
                raise self._translate(err)
