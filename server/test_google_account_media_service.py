"""Offline checks for Google Drive / Google Photos media browsing; HTTP is faked."""
import unittest

from google_account_media_service import (
    GoogleAccountMedia,
    GoogleMediaUnavailable,
    build_drive_query,
    is_google_media_url,
    sized_thumbnail_link,
)


class FakeCreds:
    valid = True


class FakeCalendar:
    def __init__(self, creds=True):
        self.creds = FakeCreds() if creds else None
        self.token_path = None


class FakeResponse:
    def __init__(self, status=200, json_data=None, content=b"", content_type="application/json", text=""):
        self.status_code = status
        self._json = json_data or {}
        self.content = content
        self.headers = {"Content-Type": content_type}
        self.text = text

    def json(self):
        return self._json


class FakeSession:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        for (m, prefix), resp in self.routes.items():
            if m == method and url.startswith(prefix):
                return resp
        raise AssertionError(f"unexpected request {method} {url}")


def make(routes, creds=True):
    session = FakeSession(routes)
    media = GoogleAccountMedia(FakeCalendar(creds), session_factory=lambda creds: session)
    return media, session


class HelperTests(unittest.TestCase):
    def test_drive_query_escapes_search_and_filters_gifs(self):
        q = build_drive_query("dad's \\ pics", "gif")
        self.assertIn("mimeType = 'image/gif'", q)
        self.assertIn("name contains 'dad\\'s \\\\ pics'", q)
        self.assertIn("trashed = false", q)

    def test_drive_query_categories(self):
        self.assertIn("starred = true", build_drive_query("", "starred"))
        self.assertIn("sharedWithMe = true", build_drive_query("", "shared"))
        self.assertIn("mimeType contains 'image/'", build_drive_query("", "all"))

    def test_only_google_hosts_get_the_token(self):
        self.assertTrue(is_google_media_url("https://lh3.googleusercontent.com/abc"))
        self.assertFalse(is_google_media_url("http://lh3.googleusercontent.com/abc"))
        self.assertFalse(is_google_media_url("https://googleusercontent.com.evil.example/abc"))

    def test_thumbnail_size(self):
        self.assertEqual(sized_thumbnail_link("https://lh3.googleusercontent.com/x=s220"),
                         "https://lh3.googleusercontent.com/x=s512")


class GoogleAccountMediaTests(unittest.TestCase):
    def test_signed_out(self):
        media, _ = make({}, creds=False)
        self.assertFalse(media.status()["signed_in"])
        with self.assertRaises(GoogleMediaUnavailable) as ctx:
            media.list_drive_images()
        self.assertEqual(ctx.exception.reason, "signed_out")

    def test_missing_scope_asks_for_permission(self):
        media, _ = make({("GET", "https://www.googleapis.com/drive/v3/files"): FakeResponse(
            403, text='{"error": {"message": "Request had insufficient authentication scopes."}}')})
        with self.assertRaises(GoogleMediaUnavailable) as ctx:
            media.list_drive_images()
        self.assertEqual(ctx.exception.reason, "needs_permission")

    def test_disabled_api(self):
        media, _ = make({("POST", "https://photospicker.googleapis.com/v1/sessions"): FakeResponse(
            403, text="Photos Picker API has not been used in project 123 before or it is disabled. SERVICE_DISABLED")})
        with self.assertRaises(GoogleMediaUnavailable) as ctx:
            media.create_photos_session()
        self.assertEqual(ctx.exception.reason, "api_disabled")

    def test_drive_listing_and_thumbnail_proxy(self):
        thumb = "https://lh3.googleusercontent.com/drive-thumb=s220"
        media, session = make({
            ("GET", "https://www.googleapis.com/drive/v3/files"): FakeResponse(json_data={
                "nextPageToken": "next",
                "files": [{
                    "id": "f1", "name": "cat.gif", "mimeType": "image/gif", "size": "1000",
                    "thumbnailLink": thumb, "imageMediaMetadata": {"width": 64, "height": 20},
                }],
            }),
            ("GET", "https://lh3.googleusercontent.com/"): FakeResponse(content=b"PNG", content_type="image/png"),
        })
        result = media.list_drive_images("cat", "all", None, 24)
        self.assertEqual(result["nextPageToken"], "next")
        item = result["items"][0]
        self.assertEqual((item["id"], item["width"], item["isAnimated"], item["previewFull"]), ("f1", 64, True, True))
        self.assertIn("name contains 'cat'", session.calls[0][2]["params"]["q"])

        content, ctype = media.drive_thumbnail("f1")
        self.assertEqual((content, ctype), (b"PNG", "image/png"))
        self.assertEqual(session.calls[-1][1], "https://lh3.googleusercontent.com/drive-thumb=s512")

    def test_photos_picker_flow_keeps_urls_server_side(self):
        base = "https://lh3.googleusercontent.com/photo123"
        media, session = make({
            ("POST", "https://photospicker.googleapis.com/v1/sessions"): FakeResponse(json_data={
                "id": "s1", "pickerUri": "https://photos.google.com/picker/s1",
                "pollingConfig": {"pollInterval": "5s"}, "mediaItemsSet": False,
            }),
            ("GET", "https://photospicker.googleapis.com/v1/sessions/s1"): FakeResponse(json_data={
                "id": "s1", "mediaItemsSet": True}),
            ("GET", "https://photospicker.googleapis.com/v1/mediaItems"): FakeResponse(json_data={
                "mediaItems": [
                    {"id": "p1", "type": "PHOTO", "mediaFile": {
                        "baseUrl": base, "mimeType": "image/jpeg", "filename": "IMG_1.jpg",
                        "mediaFileMetadata": {"width": 4000, "height": 3000}}},
                    {"id": "v1", "type": "VIDEO", "mediaFile": {"baseUrl": base + "v", "mimeType": "video/mp4"}},
                    {"id": "bad", "type": "PHOTO", "mediaFile": {"baseUrl": "https://evil.example/x", "mimeType": "image/png"}},
                ]}),
            ("GET", base): FakeResponse(content=b"JPEG", content_type="image/jpeg"),
        })
        created = media.create_photos_session()
        self.assertEqual((created["id"], created["pollIntervalMs"]), ("s1", 5000))
        self.assertTrue(media.get_photos_session("s1")["mediaItemsSet"])

        listed = media.list_photos_items("s1")
        self.assertEqual([i["id"] for i in listed["items"]], ["p1"])
        self.assertEqual(listed["skippedVideos"], 1)
        self.assertNotIn("baseUrl", listed["items"][0])

        self.assertEqual(media.photos_media("p1", thumb=False)[0], b"JPEG")
        self.assertEqual(session.calls[-1][1], base + "=d")
        media.photos_media("p1", thumb=True)
        self.assertEqual(session.calls[-1][1], base + "=w512-h512")

        with self.assertRaises(GoogleMediaUnavailable) as ctx:
            media.photos_media("unknown", thumb=True)
        self.assertEqual(ctx.exception.reason, "expired")


if __name__ == "__main__":
    unittest.main()
