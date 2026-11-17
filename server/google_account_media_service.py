"""Browse the signed-in Google account's Google Drive images and Google Photos.

Uses the same Google sign-in as Today's Schedule (calendar_service.creds).

Drive: lists image files with the drive.readonly scope and proxies thumbnails
and file bytes, because Drive URLs need the account's access token.

Photos: Google no longer lets apps read a whole Photos library, so this uses
the Photos Picker API. The browser opens Google's picker page, the user picks
photos there, and this module lists and proxies what they picked. Media URLs
stay on the server (keyed by item id) so the access token is only ever sent
to Google.
"""
import os
import threading
from typing import Callable, Dict, Optional
from urllib.parse import urlparse

DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
PHOTOS_PICKER_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly"

DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
PICKER_API = "https://photospicker.googleapis.com/v1"

DRIVE_FIELDS = (
    "nextPageToken, files(id, name, mimeType, thumbnailLink, size, modifiedTime, "
    "imageMediaMetadata(width, height))"
)
# Animated GIFs larger than this show their static thumbnail in the grid.
MAX_ANIMATED_PREVIEW_BYTES = 4 * 1024 * 1024
MAX_MEDIA_BYTES = 40 * 1024 * 1024

PRODUCT_NAMES = {"drive": "Google Drive", "photos": "Google Photos"}
API_NAMES = {"drive": "Google Drive API", "photos": "Google Photos Picker API"}


class GoogleMediaUnavailable(Exception):
    """The account can't be used yet; `reason` tells the UI what the user must do."""

    def __init__(self, reason: str, message: str, status: int = 409):
        super().__init__(message)
        self.reason = reason
        self.status = status


def escape_drive_query(text: str) -> str:
    return text.replace("\\", "\\\\").replace("'", "\\'")


def build_drive_query(search: str = "", category: str = "all") -> str:
    clauses = ["trashed = false"]
    if category == "gif":
        clauses.append("mimeType = 'image/gif'")
    else:
        clauses.append("mimeType contains 'image/'")
    if category == "starred":
        clauses.append("starred = true")
    if category == "shared":
        clauses.append("sharedWithMe = true")
    search = (search or "").strip()
    if search:
        clauses.append(f"name contains '{escape_drive_query(search)}'")
    return " and ".join(clauses)


def is_google_media_url(url: str) -> bool:
    parsed = urlparse(url or "")
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (
        host.endswith(".googleusercontent.com") or host.endswith(".google.com") or host.endswith(".googleapis.com")
    )


def sized_thumbnail_link(link: str, size: int = 512) -> str:
    # Drive thumbnail links end in "=s220"; ask for a sharper preview.
    if not link:
        return link
    head, sep, tail = link.rpartition("=s")
    if sep and tail.isdigit():
        return f"{head}=s{size}"
    return link


class GoogleAccountMedia:
    def __init__(self, calendar_service, session_factory: Optional[Callable] = None):
        self.calendar_service = calendar_service
        self._session_factory = session_factory
        self._lock = threading.Lock()
        self._drive_files: Dict[str, dict] = {}
        self._photo_items: Dict[str, dict] = {}

    # -- plumbing -------------------------------------------------------------

    def _session(self, product: str):
        service = self.calendar_service
        if not getattr(service, "creds", None):
            raise GoogleMediaUnavailable("signed_out", f"Sign in with Google to browse {PRODUCT_NAMES[product]}.")
        try:
            if not service.creds.valid:
                service._ensure_valid()
        except Exception as err:
            raise GoogleMediaUnavailable("signed_out", f"Google sign-in expired: {err}")
        if not service.creds.valid:
            raise GoogleMediaUnavailable("signed_out", f"Sign in with Google to browse {PRODUCT_NAMES[product]}.")
        if self._session_factory:
            return self._session_factory(service.creds)
        from google.auth.transport.requests import AuthorizedSession
        return AuthorizedSession(service.creds)

    @staticmethod
    def _translate(product: str, status: int, text: str) -> GoogleMediaUnavailable:
        lowered = (text or "").lower()
        if status == 401:
            return GoogleMediaUnavailable("signed_out", "Google sign-in expired. Sign in again.")
        if status == 403 and ("insufficient" in lowered or "scope" in lowered):
            return GoogleMediaUnavailable(
                "needs_permission",
                f"Sign in with Google again to let LED Sign see your {PRODUCT_NAMES[product]}.",
            )
        if status == 403 and ("accessnotconfigured" in lowered or "service_disabled" in lowered
                              or "has not been used" in lowered or "is disabled" in lowered):
            return GoogleMediaUnavailable(
                "api_disabled", f"Enable the {API_NAMES[product]} for this app's Google Cloud project."
            )
        if status == 404:
            return GoogleMediaUnavailable("not_found", "That item is no longer available.", status=404)
        return GoogleMediaUnavailable("error", f"{PRODUCT_NAMES[product]} error ({status}): {text[:300]}", status=502)

    def _request(self, product: str, method: str, url: str, **kwargs):
        session = self._session(product)
        kwargs.setdefault("timeout", 30)
        try:
            resp = session.request(method, url, **kwargs)
        except GoogleMediaUnavailable:
            raise
        except Exception as err:
            message = str(err)
            if "invalid_grant" in message or "invalid_scope" in message:
                raise GoogleMediaUnavailable("signed_out", f"Google sign-in expired: {message}")
            raise GoogleMediaUnavailable("error", f"Could not reach {PRODUCT_NAMES[product]}: {message}", status=502)
        if resp.status_code >= 400:
            raise self._translate(product, resp.status_code, resp.text or "")
        return resp

    def _download(self, product: str, url: str):
        resp = self._request(product, "GET", url)
        content = resp.content
        if len(content) > MAX_MEDIA_BYTES:
            raise GoogleMediaUnavailable("too_large", "That file is too large to use on the sign.", status=413)
        content_type = (resp.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
        return content, content_type

    def status(self) -> dict:
        creds = getattr(self.calendar_service, "creds", None)
        token_path = getattr(self.calendar_service, "token_path", None)
        try:
            # Changes when the user signs in again, so the panel knows to retry.
            token_updated = int(os.path.getmtime(token_path) * 1000) if creds and token_path else 0
        except OSError:
            token_updated = 0
        scopes = getattr(creds, "scopes", None) if creds else None
        photos_permitted = bool(PHOTOS_PICKER_SCOPE in scopes) if scopes is not None else bool(creds)
        return {
            "signed_in": bool(creds),
            "token_updated": token_updated,
            "photos_permitted": photos_permitted,
        }

    # -- Google Drive ---------------------------------------------------------

    def list_drive_images(self, search: str = "", category: str = "all",
                          page_token: Optional[str] = None, page_size: int = 24) -> dict:
        params = {
            "q": build_drive_query(search, category),
            "fields": DRIVE_FIELDS,
            "pageSize": max(1, min(int(page_size), 100)),
            "orderBy": "modifiedTime desc",
            "spaces": "drive",
            "supportsAllDrives": "true",
        }
        if page_token:
            params["pageToken"] = page_token
        data = self._request("drive", "GET", DRIVE_FILES_URL, params=params).json()

        items = []
        with self._lock:
            for f in data.get("files", []):
                meta = f.get("imageMediaMetadata") or {}
                size = int(f.get("size") or 0)
                is_gif = f.get("mimeType") == "image/gif"
                self._drive_files[f["id"]] = {"thumbnailLink": f.get("thumbnailLink"), "mimeType": f.get("mimeType")}
                items.append({
                    "id": f["id"],
                    "title": f.get("name") or "Untitled",
                    "mimeType": f.get("mimeType"),
                    "width": meta.get("width") or 0,
                    "height": meta.get("height") or 0,
                    "size": size,
                    "modifiedTime": f.get("modifiedTime"),
                    "isAnimated": is_gif,
                    "hasThumbnail": bool(f.get("thumbnailLink")),
                    "previewFull": is_gif and 0 < size <= MAX_ANIMATED_PREVIEW_BYTES,
                })
        return {"items": items, "nextPageToken": data.get("nextPageToken")}

    def drive_thumbnail(self, file_id: str):
        with self._lock:
            link = (self._drive_files.get(file_id) or {}).get("thumbnailLink")
        if not link:
            meta = self._request("drive", "GET", f"{DRIVE_FILES_URL}/{file_id}",
                                 params={"fields": "thumbnailLink", "supportsAllDrives": "true"}).json()
            link = meta.get("thumbnailLink")
        if not link or not is_google_media_url(link):
            raise GoogleMediaUnavailable("not_found", "No preview is available for that file.", status=404)
        return self._download("drive", sized_thumbnail_link(link))

    def drive_file(self, file_id: str):
        return self._download("drive", f"{DRIVE_FILES_URL}/{file_id}?alt=media&supportsAllDrives=true")

    # -- Google Photos (Picker API) -------------------------------------------

    def create_photos_session(self) -> dict:
        data = self._request("photos", "POST", f"{PICKER_API}/sessions", json={}).json()
        return self._session_summary(data)

    def get_photos_session(self, session_id: str) -> dict:
        data = self._request("photos", "GET", f"{PICKER_API}/sessions/{session_id}").json()
        return self._session_summary(data)

    def delete_photos_session(self, session_id: str) -> None:
        try:
            self._request("photos", "DELETE", f"{PICKER_API}/sessions/{session_id}")
        except GoogleMediaUnavailable as err:
            if err.reason != "not_found":
                raise

    @staticmethod
    def _session_summary(data: dict) -> dict:
        polling = data.get("pollingConfig") or {}
        interval = str(polling.get("pollInterval") or "3s").rstrip("s")
        try:
            interval_ms = max(1000, int(float(interval) * 1000))
        except ValueError:
            interval_ms = 3000
        picker_uri = data.get("pickerUri") or ""
        return {
            "id": data.get("id"),
            "pickerUri": picker_uri,
            "mediaItemsSet": bool(data.get("mediaItemsSet")),
            "pollIntervalMs": interval_ms,
            "expireTime": data.get("expireTime"),
        }

    def list_photos_items(self, session_id: str, page_token: Optional[str] = None, page_size: int = 50) -> dict:
        params = {"sessionId": session_id, "pageSize": max(1, min(int(page_size), 100))}
        if page_token:
            params["pageToken"] = page_token
        data = self._request("photos", "GET", f"{PICKER_API}/mediaItems", params=params).json()

        items = []
        skipped_videos = 0
        with self._lock:
            for m in data.get("mediaItems", []):
                media = m.get("mediaFile") or {}
                base_url = media.get("baseUrl")
                if m.get("type") == "VIDEO":
                    skipped_videos += 1
                    continue
                if not base_url or not is_google_media_url(base_url):
                    continue
                meta = media.get("mediaFileMetadata") or {}
                mime = media.get("mimeType") or "image/jpeg"
                self._photo_items[m["id"]] = {"baseUrl": base_url, "mimeType": mime}
                items.append({
                    "id": m["id"],
                    "title": media.get("filename") or "Photo",
                    "mimeType": mime,
                    "width": meta.get("width") or 0,
                    "height": meta.get("height") or 0,
                    "createTime": m.get("createTime"),
                    "isAnimated": mime == "image/gif",
                    "hasThumbnail": True,
                    "previewFull": mime == "image/gif",
                })
        return {"items": items, "nextPageToken": data.get("nextPageToken"), "skippedVideos": skipped_videos}

    def photos_media(self, item_id: str, thumb: bool):
        with self._lock:
            entry = self._photo_items.get(item_id)
        if not entry:
            raise GoogleMediaUnavailable(
                "expired", "This photo's link has expired. Choose it from Google Photos again.", status=404
            )
        # "=d" downloads the original bytes (keeps GIF animation).
        suffix = "=w512-h512" if thumb else "=d"
        return self._download("photos", entry["baseUrl"] + suffix)
