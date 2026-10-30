import os
import json
import uuid
import math
import re
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
MATERIALS_CACHE_FILE = os.path.join(os.path.dirname(__file__), ".loy_materials_cache.json")


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

# Comprehensive English to Chinese tags and category associations for search
SEARCH_ALIASES = {
    # Holidays, Christmas & Celebrations
    "christmas": {"tags": ["圣诞", "christmas", "xmas", "santa", "merry", "noel"], "cat_id": 2},
    "xmas": {"tags": ["圣诞", "christmas", "xmas", "santa"], "cat_id": 2},
    "santa": {"tags": ["圣诞", "santa", "christmas"], "cat_id": 2},
    "merry": {"tags": ["圣诞", "merry", "christmas"], "cat_id": 2},
    "holiday": {"tags": ["节假日", "holiday", "holidays", "圣诞", "christmas", "新年"], "cat_id": 2},
    "holidays": {"tags": ["节假日", "holiday", "holidays", "圣诞", "christmas", "新年"], "cat_id": 2},
    "new year": {"tags": ["新年", "元旦", "new year"], "cat_id": 2},
    "halloween": {"tags": ["万圣节", "halloween", "ghost", "pumpkin"], "cat_id": 2},

    # Fire / Flame / Hot
    "fire": {"tags": ["火", "焰", "炎", "fire", "flame", "hot"], "cat_id": 49},
    "flame": {"tags": ["火", "焰", "flame", "fire"], "cat_id": 49},
    "hot": {"tags": ["热门", "hot", "exclusive", "火"], "cat_id": 49},

    # Characters, Animals & Icons
    "bear": {"tags": ["熊", "小熊", "bear", "teddy"]},
    "dog": {"tags": ["狗", "dog", "puppy"]},
    "cat": {"tags": ["猫", "cat", "kitty"]},
    "pikachu": {"tags": ["皮卡丘", "pikachu", "pika", "pokemon"]},
    "pika": {"tags": ["皮卡丘", "pikachu", "pika"]},
    "pokemon": {"tags": ["宝可梦", "皮卡丘", "pokemon"]},
    "mario": {"tags": ["马里奥", "mario"]},
    "battery": {"tags": ["电池", "battery", "bat"]},
    "police": {"tags": ["police", "警", "交警"]},
    "pacman": {"tags": ["吃豆人", "pacman"]},

    # Emotions, Gestures & Symbols
    "heart": {"tags": ["心", "爱", "heart", "love"]},
    "love": {"tags": ["爱", "心", "love", "heart"]},
    "star": {"tags": ["星", "star", "stars"]},
    "skull": {"tags": ["骷髅", "skull"]},
    "smile": {"tags": ["表情", "smile", "laugh", "happy", "笑"], "cat_id": 3},
    "laugh": {"tags": ["表情", "smile", "laugh", "笑"], "cat_id": 3},
    "happy": {"tags": ["表情", "happy", "smile", "笑"], "cat_id": 3},
    "expression": {"tags": ["表情", "smile", "expression", "face", "emoji", "笑"], "cat_id": 3},
    "emoji": {"tags": ["表情", "emoji", "smile"], "cat_id": 3},
    "warning": {"tags": ["警示", "warning", "warn", "danger", "注意"], "cat_id": 10},
    "warn": {"tags": ["警示", "warning", "warn", "danger"], "cat_id": 10},
    "danger": {"tags": ["危险", "警示", "danger", "warning"], "cat_id": 10},

    # Community Categories
    "eye": {"tags": ["眼睛", "eye", "eyes", "眼"], "cat_id": 13},
    "eyes": {"tags": ["眼睛", "eye", "eyes", "眼"], "cat_id": 13},
    "motorcycle": {"tags": ["机车", "摩托", "motorcycle", "bike", "moto"], "cat_id": 14},
    "moto": {"tags": ["机车", "摩托", "moto", "motorcycle"], "cat_id": 14},
    "bike": {"tags": ["机车", "摩托", "motorcycle", "bike"], "cat_id": 14},
    "car": {"tags": ["汽车", "车", "car", "auto", "driver"], "cat_id": 5},
    "auto": {"tags": ["汽车", "车", "auto", "car"], "cat_id": 5},
    "driver": {"tags": ["汽车", "车", "driver", "car"], "cat_id": 5},
    "picture": {"tags": ["图片", "picture", "pic", "图"], "cat_id": 12},
    "pixel": {"tags": ["像素", "pixel", "8bit"], "cat_id": 7},
    "word": {"tags": ["文字", "word", "text", "字"], "cat_id": 8},
    "text": {"tags": ["文字", "word", "text", "字"], "cat_id": 8},
    "logo": {"tags": ["车标", "logo", "auto logos", "标"], "cat_id": 11},
    "logos": {"tags": ["车标", "logo", "auto logos", "标"], "cat_id": 11},
    "creativity": {"tags": ["创意", "creativity", "creative", "创"], "cat_id": 9},
    "creative": {"tags": ["创意", "creativity", "creative"], "cat_id": 9},
    "welfare": {"tags": ["公益", "public welfare", "welfare"], "cat_id": 4},
    "business": {"tags": ["商业", "business"], "cat_id": 6},
    "exclusive": {"tags": ["专属", "exclusive"], "cat_id": 1},
    "new": {"tags": ["最新", "new", "newest"], "cat_id": 48},

    # Colors
    "red": {"tags": ["红", "red"]},
    "blue": {"tags": ["蓝", "blue"]},
    "green": {"tags": ["绿", "green"]},
    "yellow": {"tags": ["黄", "yellow"]},
    "purple": {"tags": ["紫", "purple"]},
    "white": {"tags": ["白", "white"]},
    "cyan": {"tags": ["青", "cyan"]},
}

class LoySpaceService:
    def __init__(self):
        self._user_id: Optional[str] = None
        self._key: Optional[str] = None
        self._session = requests.Session()
        self._last_login_time = 0
        self._categories_cache: Optional[List[Dict[str, Any]]] = None
        self._categories_cache_time: float = 0
        self._cache_file = MATERIALS_CACHE_FILE
        self._materials_pool: Dict[int, Dict[str, Any]] = {}
        self._load_materials_cache()

    def _load_materials_cache(self) -> None:
        try:
            if os.path.exists(self._cache_file):
                with open(self._cache_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        for k, v in data.items():
                            try:
                                iid = int(k)
                                if isinstance(v, dict):
                                    self._materials_pool[iid] = v
                            except (ValueError, TypeError):
                                pass
        except Exception as e:
            print(f"[LoySpaceService] Could not load materials cache: {e}")

    def _save_materials_cache(self) -> None:
        try:
            temp_path = self._cache_file + ".tmp"
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(self._materials_pool, f, ensure_ascii=False, indent=2)
            os.replace(temp_path, self._cache_file)
        except Exception as e:
            print(f"[LoySpaceService] Could not save materials cache: {e}")

    def _index_materials(self, raw_items: List[Dict[str, Any]], category_id: Optional[int] = None) -> None:
        if not isinstance(raw_items, list) or not raw_items:
            return
        updated = False
        for item in raw_items:
            if not isinstance(item, dict):
                continue
            iid = item.get("id")
            if not iid:
                continue
            try:
                iid = int(iid)
            except (ValueError, TypeError):
                continue
            if category_id is not None and "tags" not in item:
                item["tags"] = category_id
            if iid not in self._materials_pool:
                self._materials_pool[iid] = item
                updated = True
            else:
                self._materials_pool[iid].update({k: v for k, v in item.items() if v is not None})
        if updated:
            self._save_materials_cache()

    def _seed_initial_pool(self, w: int = 64, h: int = 20) -> None:
        """Seed pool with Hot, Holidays, and New if cache is empty."""
        try:
            for cat_id, cat_type, pcount in [(49, 2, 200), (2, 1, 50), (48, 0, 200)]:
                items = self._query_api("query_material_list", {
                    "page_count": pcount,
                    "page_index": 0,
                    "w": w,
                    "h": h,
                    "type": cat_type,
                    "tags": cat_id,
                    "sort": 0,
                    "lang": 2
                })
                if isinstance(items, list) and items:
                    self._index_materials(items, cat_id)
        except Exception as e:
            print(f"[LoySpaceService] Seed error: {e}")

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

    def _query_api(self, endpoint: str, params: Dict[str, Any], timeout: float = 3.5) -> List[Dict[str, Any]]:
        params["userid"] = self._user_id
        params["ts"] = int(time.time() * 1000)
        params["token"] = self._generate_token(params, self._key)
        try:
            resp = self._session.post(BASE_URL + endpoint, data=params, timeout=timeout)
            res_json = resp.json()
            if res_json.get("status") in (101, 102, 103):
                if self._ensure_login(force=True):
                    params["userid"] = self._user_id
                    params["ts"] = int(time.time() * 1000)
                    params["token"] = self._generate_token(params, self._key)
                    resp = self._session.post(BASE_URL + endpoint, data=params, timeout=timeout)
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
            query_words = [w_term for w_term in re.split(r'\s+', raw_query) if w_term]

            # 1. Expand search terms via aliases & categories
            alias_info = SEARCH_ALIASES.get(raw_query)
            search_terms = [raw_query] + query_words
            cat_id_to_fetch = None
            if alias_info:
                search_terms.extend(alias_info.get("tags", []))
                cat_id_to_fetch = alias_info.get("cat_id")

            # Check if query directly matches any known category name
            if not cat_id_to_fetch:
                for c in LOY_CATEGORIES:
                    cname = c["name"].lower()
                    if raw_query in cname or any(qw in cname for qw in query_words):
                        cat_id_to_fetch = c["id"]
                        break

            # Deduplicate search terms (all lowercase for case-insensitive matching)
            search_terms = list(dict.fromkeys([t.lower() for t in search_terms if t]))

            def _score_pool() -> List[Dict[str, Any]]:
                candidates = []
                for item in self._materials_pool.values():
                    m_name = (item.get("m_name") or item.get("name") or "").lower()
                    mark = (item.get("mark") or "").lower()
                    name_en = (item.get("name_en") or "").lower()
                    mark_en = (item.get("mark_en") or "").lower()
                    tag_diy = (item.get("tag_diy") or "").lower()
                    all_text = f"{m_name} {mark} {name_en} {mark_en} {tag_diy}"

                    score = 0.0
                    for term in search_terms:
                        if term in m_name:
                            score += 100.0
                            if m_name.startswith(term):
                                score += 40.0
                        elif term in mark:
                            score += 40.0
                        elif term in tag_diy:
                            score += 50.0
                        elif term in all_text:
                            score += 25.0

                    if cat_id_to_fetch and item.get("tags") == cat_id_to_fetch:
                        score += 20.0

                    if score > 0:
                        use = item.get("count_use", 0) or 0
                        fav = item.get("count_favorite", 0) or 0
                        try:
                            score += math.log1p(float(use)) * 2.0 + math.log1p(float(fav))
                        except Exception:
                            pass
                        candidates.append((score, item))

                candidates.sort(key=lambda x: x[0], reverse=True)
                return [item for _, item in candidates]

            # Fast path: Score our indexed local pool first. If matches are found, return immediately!
            matched_raw = _score_pool()

            # If no matches found locally, try fetching the specific category or remote tags with a fast timeout
            if not matched_raw:
                if cat_id_to_fetch:
                    has_cat_in_pool = any(it.get("tags") == cat_id_to_fetch for it in self._materials_pool.values())
                    if not has_cat_in_pool:
                        cat_items = self._query_api("query_material_list", {
                            "page_count": 200,
                            "page_index": 0,
                            "w": w,
                            "h": h,
                            "type": 2 if cat_id_to_fetch == 49 else (0 if cat_id_to_fetch == 48 else 1),
                            "tags": cat_id_to_fetch,
                            "sort": 0,
                            "lang": 2
                        }, timeout=3.0)
                        if isinstance(cat_items, list) and cat_items:
                            self._index_materials(cat_items, cat_id_to_fetch)
                            matched_raw = _score_pool()

                if not matched_raw:
                    # Try remote tag_diy search once with short timeout
                    diy_tags_to_check = [raw_query]
                    if alias_info:
                        diy_tags_to_check.extend(alias_info.get("tags", [])[:1])
                    for stag in list(dict.fromkeys(diy_tags_to_check))[:1]:
                        tag_items = self._query_api("query_material_list_by_tag_diy", {
                            "page_count": 50,
                            "page_index": 0,
                            "w": w,
                            "h": h,
                            "tag_diy": stag,
                            "lang": 2
                        }, timeout=2.5)
                        if isinstance(tag_items, list) and tag_items:
                            self._index_materials(tag_items)
                    matched_raw = _score_pool()

            # Clean and paginate
            cleaned_items = self._clean_items(matched_raw, w, h)
            total_matches = len(cleaned_items)
            start_idx = page_index * page_count
            end_idx = start_idx + page_count
            paginated = cleaned_items[start_idx:end_idx]

            return {
                "status": 0,
                "data": paginated,
                "has_more": end_idx < total_matches,
                "total_count": total_matches,
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

        if isinstance(raw_items, list) and raw_items:
            self._index_materials(raw_items, tag_id)

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
