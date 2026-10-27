import os
import json
import uuid
"""
LOY SPACE API Service -- Integrates LEDSign with the LOY SPACE online material library.

Provides categories, material search, and paging filtered strictly to 64x20 items.
"""

import time
import hashlib
import requests
from typing import List, Dict, Any, Optional

BASE_URL = "https://wxbtapp-cdn.popled.cn/"
CDN_BASE = "https://store-cdn.popled.cn"
ORIG_CDN = "https://lmq6store.popled.cn"

GUEST_SESSION_FILE = os.path.join(os.path.dirname(__file__), ".loy_guest.json")
USER_SESSION_FILE = os.path.join(os.path.dirname(__file__), ".loy_user.json")
UPLOADS_TRACK_FILE = os.path.join(os.path.dirname(__file__), ".loy_uploads.json")


# Official categories matching LOY SPACE app's get_config (tags_type=2) order and 64x20 active tags
LOY_CATEGORIES = [
    {"id": 13, "name": "Eye", "type": 1},
    {"id": 48, "name": "New", "type": 0},
    {"id": 14, "name": "Motorcycle", "type": 1},
    {"id": 1, "name": "Exclusive", "type": 1},
    {"id": 49, "name": "Hot", "type": 2},
    {"id": 5, "name": "Driver", "type": 1},
    {"id": 3, "name": "Expression", "type": 1},
    {"id": 10, "name": "Warning", "type": 1},
    {"id": 12, "name": "Picture", "type": 1},
    {"id": 7, "name": "Pixel", "type": 1},
    {"id": 8, "name": "Word", "type": 1},
    {"id": 11, "name": "Auto Logos", "type": 1},
    {"id": 2, "name": "Holidays", "type": 1},
    {"id": 9, "name": "Creativity", "type": 1},
    {"id": 4, "name": "Public Welfare", "type": 1},
    {"id": 6, "name": "Business", "type": 1},
]

# Common English to Chinese tags and category associations for search
SEARCH_ALIASES = {
    "eye": {"tags": ["眼睛", "eye", "eyes"], "cat_id": 13},
    "eyes": {"tags": ["眼睛", "eye", "eyes"], "cat_id": 13},
    "motorcycle": {"tags": ["机车", "摩托", "motorcycle", "bike", "moto"], "cat_id": 14},
    "bike": {"tags": ["机车", "摩托", "motorcycle", "bike"], "cat_id": 14},
    "car": {"tags": ["汽车", "car", "auto", "driver"], "cat_id": 5},
    "driver": {"tags": ["汽车", "driver", "car"], "cat_id": 5},
    "expression": {"tags": ["表情", "smile", "expression", "face", "emoji"], "cat_id": 3},
    "smile": {"tags": ["表情", "smile", "laugh"], "cat_id": 3},
    "warning": {"tags": ["警示", "warning", "warn", "danger"], "cat_id": 10},
    "picture": {"tags": ["图片", "picture", "pic"], "cat_id": 12},
    "pixel": {"tags": ["像素", "pixel"], "cat_id": 7},
    "word": {"tags": ["文字", "word", "text"], "cat_id": 8},
    "text": {"tags": ["文字", "word", "text"], "cat_id": 8},
    "logo": {"tags": ["车标", "logo", "auto logos"], "cat_id": 11},
    "logos": {"tags": ["车标", "logo", "auto logos"], "cat_id": 11},
    "holiday": {"tags": ["节假日", "holiday", "holidays", "christmas", "xmas"], "cat_id": 2},
    "holidays": {"tags": ["节假日", "holiday", "holidays"], "cat_id": 2},
    "creativity": {"tags": ["创意", "creativity", "creative"], "cat_id": 9},
    "creative": {"tags": ["创意", "creativity", "creative"], "cat_id": 9},
    "welfare": {"tags": ["公益", "public welfare", "welfare"], "cat_id": 4},
    "business": {"tags": ["商业", "business"], "cat_id": 6},
    "hot": {"tags": ["热门", "hot", "exclusive"], "cat_id": 1},
    "exclusive": {"tags": ["热门", "exclusive"], "cat_id": 1},
}

class LoySpaceService:
    def __init__(self):
        self._user_id: Optional[str] = None
        self._key: Optional[str] = None
        self._session = requests.Session()
        self._last_login_time = 0
        self._categories_cache: Optional[List[Dict[str, Any]]] = None
        self._categories_cache_time: float = 0

    def _ensure_login(self, force: bool = False) -> bool:
        """Authenticate as guest/appout user with LOY SPACE API."""
        now = time.time()
        # Token valid for 24h; re-login if older or forced
        if not force and self._key and self._user_id and (now - self._last_login_time < 86400):
            return True

        try:
            resp = self._session.post(
                BASE_URL + "login",
                data={"user": "pub_appout", "pwd": "382fe2736ff9aed149c0f7257cbc2894"},
                timeout=10
            )
            data = resp.json()
            if data.get("status") == 0:
                user_info = data.get("data", {})
                self._user_id = str(user_info.get("userid", "3"))
                self._key = str(user_info.get("key", ""))
                self._last_login_time = now
                return True
        except Exception as e:
            print(f"[LoySpaceService] Login error: {e}")
        return False

    def _generate_token(self, params: Dict[str, Any], key: str) -> str:
        """Generate MD5 signature for LOY SPACE API."""
        sorted_keys = sorted(params.keys())
        s = ""
        for k in sorted_keys:
            val = str(params[k])
            if val != "":
                s += f"{k}={val}&"
        s += f"key={key}"
        return hashlib.md5(s.encode("utf-8")).hexdigest()

    def get_categories(self, w: int = 64, h: int = 20, force_refresh: bool = False) -> List[Dict[str, Any]]:
        """Fetch and sync organization tabs directly from LOY SPACE get_config and query_material_count_groupby_tags."""
        now = time.time()
        if not force_refresh and self._categories_cache and (now - self._categories_cache_time < 300):
            return self._categories_cache

        if not self._ensure_login():
            return self._categories_cache or LOY_CATEGORIES

        try:
            cfg_data = self._query_api("get_config", {"tags_type": 2})
            config_tags = cfg_data.get("config_tags", []) if isinstance(cfg_data, dict) else []
            if not config_tags:
                return self._categories_cache or LOY_CATEGORIES

            counts = self._query_api("query_material_count_groupby_tags", {
                "w": w,
                "h": h,
                "lang": 2,
                "shape": 0
            })
            active_tag_ids = set()
            if isinstance(counts, list):
                for c in counts:
                    if isinstance(c, dict) and "tag" in c and int(c.get("count", 0)) > 0:
                        active_tag_ids.add(int(c["tag"]))

            synced_tabs: List[Dict[str, Any]] = []
            for ct in config_tags:
                try:
                    qtype = int(ct.get("qry_type", 1))
                    tid = int(ct.get("id", 0))
                except (ValueError, TypeError):
                    continue

                # Include community gallery tab types: 0 (New), 1 (Category tag), 2 (Hot)
                if qtype not in (0, 1, 2):
                    continue

                # Match LOY SPACE app logic: (n >= 0 || "1" != i[s].type)
                if qtype == 1 and active_tag_ids and tid not in active_tag_ids:
                    continue

                raw_name = (ct.get("mark_en") or ct.get("mark") or "").strip()
                if not raw_name:
                    continue
                formatted_name = " ".join(
                    word[0].upper() + word[1:] if word else ""
                    for word in raw_name.split(" ")
                )
                synced_tabs.append({
                    "id": tid,
                    "name": formatted_name,
                    "type": qtype
                })

            if synced_tabs:
                self._categories_cache = synced_tabs
                self._categories_cache_time = now
                return synced_tabs
        except Exception as e:
            print(f"[LoySpaceService] Error syncing live categories: {e}")

        return self._categories_cache or LOY_CATEGORIES

    def _clean_items(self, raw_items: List[Dict[str, Any]], w: int, h: int) -> List[Dict[str, Any]]:
        cleaned_items = []
        for item in raw_items:
            url = item.get("url", "")
            url_pre = item.get("url_pre", "") or url
            
            # Normalize CDN
            if ORIG_CDN in url:
                url = url.replace(ORIG_CDN, CDN_BASE)
            if ORIG_CDN in url_pre:
                url_pre = url_pre.replace(ORIG_CDN, CDN_BASE)

            # Ensure size matches 64x20
            if "64_20" not in url and ("_" in url and not url.endswith((".gif", ".png", ".jpg"))):
                continue

            # Prioritize m_name: the true actual name assigned by the uploader
            actual_name = (
                (item.get("m_name") or "").strip()
                or (item.get("name_en") or "").strip()
                or (item.get("mark") or "").strip()
                or (item.get("mark_en") or "").strip()
                or (item.get("tag_diy") or "").strip()
                or f"Material #{item.get('id', '')}"
            )

            cleaned_items.append({
                "id": item.get("id"),
                "name": actual_name,
                "raw_name": (item.get("m_name") or "").strip(),
                "description": (item.get("mark") or "").strip(),
                "url": url,
                "url_pre": url_pre,
                "count_use": item.get("count_use", 0),
                "count_favorite": item.get("count_favorite", 0),
                "w": w,
                "h": h
            })
        return cleaned_items

    def _query_api(self, endpoint: str, params: Dict[str, Any]) -> List[Dict[str, Any]]:
        params["userid"] = self._user_id
        params["ts"] = int(time.time() * 1000)
        params["token"] = self._generate_token(params, self._key)
        try:
            resp = self._session.post(BASE_URL + endpoint, data=params, timeout=10)
            res_json = resp.json()
            if res_json.get("status") in (101, 102, 103):
                if self._ensure_login(force=True):
                    params["userid"] = self._user_id
                    params["ts"] = int(time.time() * 1000)
                    params["token"] = self._generate_token(params, self._key)
                    resp = self._session.post(BASE_URL + endpoint, data=params, timeout=10)
                    res_json = resp.json()
            if res_json.get("status") == 0:
                return res_json.get("data", [])
        except Exception as e:
            print(f"[LoySpaceService] API query error for {endpoint}: {e}")
        return []

    def get_materials(
        self,
        tag_id: int = 48,
        tag_type: int = 0,
        page_index: int = 0,
        page_count: int = 24,
        search_query: Optional[str] = None,
        w: int = 64,
        h: int = 20
    ) -> Dict[str, Any]:
        """Fetch 64x20 materials by tag or search keyword."""
        if not self._ensure_login():
            return {"status": -1, "error": "Failed to authenticate with LOY SPACE", "data": [], "has_more": False}

        # Handle Search
        if search_query and search_query.strip():
            raw_query = search_query.strip().lower()
            collected_raw = []
            seen_ids = set()

            # 1. Look up any search aliases (e.g. eye -> 眼睛, plus category 13)
            alias_info = SEARCH_ALIASES.get(raw_query)
            search_tags = [search_query.strip()]
            cat_id_to_fetch = None
            if alias_info:
                search_tags.extend(alias_info.get("tags", []))
                cat_id_to_fetch = alias_info.get("cat_id")

            # Also check if query is directly part of category names
            if not cat_id_to_fetch:
                for c in LOY_CATEGORIES:
                    if raw_query in c["name"].lower() or c["name"].lower() in raw_query:
                        cat_id_to_fetch = c["id"]
                        break

            # If matching category found, query its items
            if cat_id_to_fetch:
                cat_items = self._query_api("query_material_list", {
                    "page_count": page_count,
                    "page_index": page_index,
                    "w": w,
                    "h": h,
                    "type": 1,
                    "tags": cat_id_to_fetch,
                    "sort": 0,
                    "lang": 2
                })
                for it in cat_items:
                    iid = it.get("id")
                    if iid and iid not in seen_ids:
                        seen_ids.add(iid)
                        collected_raw.append(it)

            # Query tag_diy for each variant
            for stag in list(dict.fromkeys(search_tags))[:3]:
                tag_items = self._query_api("query_material_list_by_tag_diy", {
                    "page_count": page_count,
                    "page_index": page_index,
                    "w": w,
                    "h": h,
                    "tag_diy": stag,
                    "lang": 2
                })
                for it in tag_items:
                    iid = it.get("id")
                    if iid and iid not in seen_ids:
                        seen_ids.add(iid)
                        collected_raw.append(it)

            cleaned_items = self._clean_items(collected_raw, w, h)
            return {
                "status": 0,
                "data": cleaned_items,
                "has_more": len(cleaned_items) >= page_count,
                "page_index": page_index
            }

        # Normal Category Browsing
        raw_items = self._query_api("query_material_list", {
            "page_count": page_count,
            "page_index": page_index,
            "w": w,
            "h": h,
            "type": tag_type,
            "tags": tag_id,
            "sort": 0,
            "lang": 2
        })

        cleaned_items = self._clean_items(raw_items, w, h)
        return {
            "status": 0,
            "data": cleaned_items,
            "has_more": len(raw_items) >= page_count,
            "page_index": page_index
        }

    def proxy_download(self, url: str) -> Optional[tuple[bytes, str]]:
        """Fetch media file bytes and content type."""
        try:
            # Allow only popled.cn domains for security
            if not any(domain in url for domain in ("popled.cn", "store-cdn.popled.cn", "lmq6store.popled.cn")):
                return None
            resp = self._session.get(url, timeout=15)
            if resp.status_code == 200:
                content_type = resp.headers.get("Content-Type", "image/gif")
                return resp.content, content_type
        except Exception as e:
            print(f"[LoySpaceService] Proxy download error: {e}")
        return None

    def get_guest_session(self) -> Dict[str, Any]:
        """Retrieve existing persistent guest session or register a new one."""
        if os.path.exists(GUEST_SESSION_FILE):
            try:
                with open(GUEST_SESSION_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if data.get("userid") and data.get("key"):
                        return data
            except Exception as e:
                print(f"[LoySpaceService] Error reading guest session: {e}")

        # Register new tourist account using device UUID
        device_id = "ledsign_" + uuid.uuid4().hex[:12]
        pwd_hash = hashlib.md5(device_id.encode("utf-8")).hexdigest()
        try:
            resp = self._session.post(
                BASE_URL + "register",
                data={"user": device_id, "pwd": pwd_hash},
                timeout=10
            )
            res = resp.json()
            if res.get("status") == 0:
                d = res.get("data", {})
                session = {
                    "userid": d.get("userid"),
                    "user": d.get("user"),
                    "key": d.get("key"),
                    "nickname": d.get("nickname") or f"Tourist_{device_id[:6]}",
                    "image_url": d.get("image_url", ""),
                    "is_guest": True
                }
                with open(GUEST_SESSION_FILE, "w", encoding="utf-8") as f:
                    json.dump(session, f, indent=2)
                return session
        except Exception as e:
            print(f"[LoySpaceService] Guest register error: {e}")

        return {
            "userid": 3,
            "user": "pub_appout",
            "key": "3-pub_appout-1749307265",
            "nickname": "Tourist_Guest",
            "is_guest": True
        }

    def login_user(self, user: str, pwd: str) -> Dict[str, Any]:
        """Authenticate user with LOY SPACE account."""
        if not user or not pwd:
            return {"status": -1, "error": "Username and password required"}

        pwd_hash = pwd if len(pwd) == 32 and all(c in "0123456789abcdefABCDEF" for c in pwd) else hashlib.md5(pwd.encode("utf-8")).hexdigest()

        try:
            resp = self._session.post(
                BASE_URL + "login",
                data={"user": user.strip(), "pwd": pwd_hash},
                timeout=10
            )
            res = resp.json()
            if res.get("status") == 0:
                d = res.get("data", {})
                session = {
                    "userid": d.get("userid"),
                    "user": d.get("user") or user.strip(),
                    "key": d.get("key"),
                    "nickname": d.get("nickname") or user.strip(),
                    "image_url": d.get("image_url", ""),
                    "is_guest": False
                }
                with open(USER_SESSION_FILE, "w", encoding="utf-8") as f:
                    json.dump(session, f, indent=2)
                return {"status": 0, "data": session}
            else:
                err_msg = res.get("errmsg_en") or res.get("errmsg_cn") or "Login failed"
                return {"status": res.get("status", 1), "error": err_msg}
        except Exception as e:
            return {"status": -1, "error": f"Login network error: {e}"}

    def logout_user(self) -> Dict[str, Any]:
        """Log out user and revert to guest mode."""
        if os.path.exists(USER_SESSION_FILE):
            try:
                os.remove(USER_SESSION_FILE)
            except Exception as e:
                print(f"[LoySpaceService] Error removing user session: {e}")
        return {"status": 0, "message": "Signed out successfully", "guest": self.get_guest_session()}

    def get_auth_status(self) -> Dict[str, Any]:
        """Check current authentication status."""
        if os.path.exists(USER_SESSION_FILE):
            try:
                with open(USER_SESSION_FILE, "r", encoding="utf-8") as f:
                    user_data = json.load(f)
                    if user_data.get("userid") and user_data.get("key"):
                        return {
                            "logged_in": True,
                            "is_guest": False,
                            "user": user_data.get("user"),
                            "userid": user_data.get("userid"),
                            "nickname": user_data.get("nickname") or user_data.get("user"),
                            "image_url": user_data.get("image_url", "")
                        }
            except Exception:
                pass

        guest = self.get_guest_session()
        return {
            "logged_in": False,
            "is_guest": True,
            "user": guest.get("user"),
            "userid": guest.get("userid"),
            "nickname": guest.get("nickname", "Guest"),
            "image_url": guest.get("image_url", "")
        }

    def get_active_session(self) -> Dict[str, Any]:
        """Get active user session (logged-in user or guest)."""
        if os.path.exists(USER_SESSION_FILE):
            try:
                with open(USER_SESSION_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if data.get("userid") and data.get("key"):
                        return data
            except Exception:
                pass
        return self.get_guest_session()

    def upload_and_share_material(
        self,
        image_bytes: bytes,
        filename: str = "canvas.png",
        name: str = "LEDSign Custom",
        mark: str = "custom,64x20",
        tags: int = 1,
        width: int = 64,
        height: int = 20
    ) -> Dict[str, Any]:
        """Upload media file to LOY SPACE and publish it to the community gallery."""
        active_user = self.get_active_session()
        user_id = active_user.get("userid")
        user_key = active_user.get("key")

        if not user_id or not user_key:
            return {"status": -1, "error": "No valid user session available"}

        ts = str(int(time.time()))
        params = {
            "userid": user_id,
            "w": width,
            "h": height,
            "name": name or "LEDSign Custom",
            "mark": mark or name or "LEDSign Custom",
            "tags": int(tags) if tags else 1,
            "tag_diy": mark or "",
            "resize": 0,
            "lang": 2,
            "ts": ts
        }

        token = self._generate_token(params, user_key)
        params["token"] = token

        files = {"file": (filename or "canvas.png", image_bytes, "image/png")}

        try:
            resp = self._session.post(
                BASE_URL + "material_upload",
                data=params,
                files=files,
                timeout=20
            )
            up_data = resp.json()
            if up_data.get("status") != 0:
                err = up_data.get("errmsg_en") or up_data.get("errmsg_cn") or "Material upload failed"
                return {"status": up_data.get("status", -1), "error": err}

            mat_id = up_data.get("data", {}).get("id")
            if not mat_id:
                return {"status": -1, "error": "Server did not return a valid material ID"}

            # Share into community queue
            share_ts = str(int(time.time()))
            share_params = {
                "userid": user_id,
                "mids": str(mat_id),
                "ts": share_ts
            }
            share_params["token"] = self._generate_token(share_params, user_key)

            share_resp = self._session.post(
                BASE_URL + "material_share",
                data=share_params,
                timeout=15
            )
            share_data = share_resp.json()
            if share_data.get("status") != 0:
                err = share_data.get("errmsg_en") or share_data.get("errmsg_cn") or "Material share failed"
                return {"status": share_data.get("status", -1), "error": err}

            # Record locally so it immediately shows in the Uploads tab
            try:
                existing_uploads = []
                if os.path.exists(UPLOADS_TRACK_FILE):
                    with open(UPLOADS_TRACK_FILE, "r", encoding="utf-8") as f:
                        existing_uploads = json.load(f)
                new_entry = {
                    "id": mat_id,
                    "name": name,
                    "m_name": name,
                    "mark": mark,
                    "url": up_data.get("data", {}).get("url"),
                    "url_pre": up_data.get("data", {}).get("url"),
                    "count_use": 1,
                    "count_favorite": 0,
                    "w": width,
                    "h": height,
                    "created_at": time.time()
                }
                existing_uploads.insert(0, new_entry)
                with open(UPLOADS_TRACK_FILE, "w", encoding="utf-8") as f:
                    json.dump(existing_uploads, f, indent=2)
            except Exception as e:
                print(f"[LoySpaceService] Error saving local upload: {e}")

            return {
                "status": 0,
                "material_id": mat_id,
                "url": up_data.get("data", {}).get("url"),
                "name": name,
                "nickname": active_user.get("nickname", "User"),
                "is_guest": active_user.get("is_guest", False)
            }
        except Exception as e:
            return {"status": -1, "error": f"Upload network error: {e}"}

    def get_user_materials(self, page_index: int = 0, page_count: int = 24) -> Dict[str, Any]:
        """Fetch materials uploaded by the current user session (cloud + local tracking)."""
        active_user = self.get_active_session()
        user_id = active_user.get("userid")
        user_key = active_user.get("key")

        collected_items = []
        seen_ids = set()

        # 1. Load locally tracked uploads
        if os.path.exists(UPLOADS_TRACK_FILE):
            try:
                with open(UPLOADS_TRACK_FILE, "r", encoding="utf-8") as f:
                    local_items = json.load(f)
                    for it in local_items:
                        iid = it.get("id")
                        if iid and iid not in seen_ids:
                            seen_ids.add(iid)
                            collected_items.append(it)
            except Exception as e:
                print(f"[LoySpaceService] Error loading local uploads: {e}")

        # 2. Query LOY cloud query_material_list_by_userid
        if user_id and user_key:
            ts = str(int(time.time() * 1000))
            params = {
                "userid": user_id,
                "page_count": page_count,
                "page_index": page_index,
                "w": 64,
                "h": 20,
                "lang": 2,
                "ts": ts
            }
            params["token"] = self._generate_token(params, user_key)
            try:
                resp = self._session.post(BASE_URL + "query_material_list_by_userid", data=params, timeout=10)
                res_data = resp.json()
                if res_data.get("status") == 0:
                    cloud_items = res_data.get("data", [])
                    for it in cloud_items:
                        iid = it.get("id")
                        if iid and iid not in seen_ids:
                            seen_ids.add(iid)
                            collected_items.append(it)
            except Exception as e:
                print(f"[LoySpaceService] Query user materials cloud error: {e}")

        cleaned = self._clean_items(collected_items, 64, 20)
        return {
            "status": 0,
            "data": cleaned,
            "has_more": False,
            "page_index": page_index
        }

loy_space_service = LoySpaceService()
