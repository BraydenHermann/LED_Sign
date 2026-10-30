import unittest
import asyncio
from fastapi import HTTPException
import server.main as main
from server.loy_space_service import loy_space_service

class TestLoySpaceIntegration(unittest.IsolatedAsyncioTestCase):
    def test_categories_order_and_count(self):
        """Verify the 16 LOY SPACE categories in exact synced order."""
        expected_names = [
            "Eye", "New", "Motorcycle", "Exclusive", "Hot", "Driver", 
            "Expression", "Warning", "Picture", "Pixel", "Word", 
            "Auto Logos", "Holidays", "Creativity", "Public Welfare", "Business"
        ]
        cats = loy_space_service.get_categories()
        actual_names = [c["name"] for c in cats]
        self.assertEqual(actual_names, expected_names)
        self.assertEqual(len(cats), 16)

    async def test_api_categories_endpoint(self):
        cats = await main.get_loy_categories()
        self.assertEqual(len(cats), 16)
        self.assertEqual(cats[0]["name"], "Eye")
        self.assertEqual(cats[1]["name"], "New")
        self.assertEqual(cats[3]["name"], "Exclusive")
        self.assertEqual(cats[4]["name"], "Hot")

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

    async def test_materials_search_christmas(self):
        res = await main.get_loy_materials(search="christmas", page_index=0, page_count=10)
        self.assertEqual(res.get("status"), 0)
        items = res.get("data", [])
        self.assertTrue(len(items) > 0)
        names = [it.get("name", "").lower() for it in items]
        self.assertTrue(any("christ" in n or "圣诞" in n for n in names))

    async def test_proxy_media_security(self):
        # Disallow domains not belonging to popled.cn
        with self.assertRaises(HTTPException) as cm:
            await main.get_loy_proxy_media("https://malicious-site.com/bad.gif")
        self.assertEqual(cm.exception.status_code, 404)

    async def test_auth_status_endpoint(self):
        status = await main.get_loy_auth_status()
        self.assertIn("logged_in", status)
        self.assertIn("is_guest", status)
        self.assertIn("nickname", status)
        self.assertIn("userid", status)

    async def test_my_materials_endpoint(self):
        res = await main.get_loy_my_materials()
        self.assertEqual(res.get("status"), 0)
        self.assertIsInstance(res.get("data"), list)

if __name__ == "__main__":
    unittest.main()
