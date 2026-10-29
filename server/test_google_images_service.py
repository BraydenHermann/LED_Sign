import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from google_images_service import _build_google_url, search_google_images


class TestGoogleImagesService(unittest.TestCase):

    def test_build_url_with_filters(self):
        import urllib.parse
        url = _build_google_url(
            query="retro neon car",
            type_filter="animated",
            aspect_filter="wide",
            color_filter="trans",
            size_filter="large",
            time_filter="week",
            page_num=2
        )
        decoded = urllib.parse.unquote(url)
        self.assertIn("q=retro+neon+car", decoded)
        self.assertIn("udm=2", decoded)
        self.assertIn("itp:animated", decoded)
        self.assertIn("iar:w", decoded)
        self.assertIn("ic:trans", decoded)
        self.assertIn("isz:l", decoded)
        self.assertIn("qdr:w", decoded)
        self.assertIn("start=20", decoded)

    def test_search_images(self):
        results = search_google_images("pixel art cat", type_filter="animated", max_results=5)
        self.assertIsInstance(results, list)
        self.assertTrue(len(results) > 0)
        item = results[0]
        self.assertIn("originalUrl", item)
        self.assertIn("thumbnailUrl", item)
        self.assertIn("title", item)
        self.assertTrue(item["originalUrl"].startswith("http"))


if __name__ == '__main__':
    unittest.main()
