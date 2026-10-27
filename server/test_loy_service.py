import unittest
import asyncio
from fastapi import HTTPException
import server.main as main
from server.loy_space_service import loy_space_service

class TestLoySpaceIntegration(unittest.IsolatedAsyncioTestCase):
    def test_categories_order_and_count(self):
        """Verify the 15 requested categories in exact order."""
        expected_names = [
            "Newest", "Eye", "Motorcycle", "Exclusive", "Driver", 
            "Expression", "Warning", "Picture", "Pixel", "Word", 
            "Auto Logos", "Holidays", "Creativity", "Public Welfare", "Business"
        ]
        cats = loy_space_service.get_categories()
        actual_names = [c["name"] for c in cats]
        self.assertEqual(actual_names, expected_names)
        self.assertEqual(len(cats), 15)

    async def test_api_categories_endpoint(self):
        cats = await main.get_loy_categories()
        self.assertEqual(len(cats), 15)
        self.assertEqual(cats[0]["name"], "Newest")
        self.assertEqual(cats[1]["name"], "Eye")

    async def test_materials_query_endpoint(self):
        res = await main.get_loy_materials(tag_id=48, tag_type=0, page_index=0, page_count=6)
        self.assertEqual(res.get("status"), 0)
        items = res.get("data", [])
        self.assertTrue(len(items) > 0)
        for item in items:
            self.assertEqual(item.get("w"), 64)
            self.assertEqual(item.get("h"), 20)
            self.assertTrue(item.get("url", "").startswith("http"))

    async def test_materials_search_endpoint(self):
        res = await main.get_loy_materials(search="cat", page_index=0, page_count=5)
        self.assertEqual(res.get("status"), 0)
        items = res.get("data", [])
        self.assertTrue(len(items) > 0)
        for item in items:
            self.assertEqual(item.get("w"), 64)
            self.assertEqual(item.get("h"), 20)

    async def test_proxy_media_security(self):
        # Disallow domains not belonging to popled.cn
        with self.assertRaises(HTTPException) as cm:
            await main.get_loy_proxy_media("https://malicious-site.com/bad.gif")
        self.assertEqual(cm.exception.status_code, 404)

if __name__ == "__main__":
    unittest.main()
