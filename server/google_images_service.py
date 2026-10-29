"""
Google Images & Media Search Service for LED Sign.
Provides fast querying of Google Images with filter controls (animated GIF, size, aspect ratio, color, time)
and media proxying for seamless canvas loading without CORS blocks.
"""

from __future__ import annotations
import os
import re
import json
import time
import threading
import concurrent.futures
import urllib.parse
from typing import Optional, List, Dict, Any, Tuple
import requests

try:
    from playwright.sync_api import sync_playwright
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

PATTERN = re.compile(
    r'\[1,\s*\[0,\s*\"(?P<id>[^\"]+?)\",\s*'
    r'\[\"(?P<thumb>https?://[^\"]+?)\",\s*(?P<thumb_h>\d+),\s*(?P<thumb_w>\d+)\],\s*'
    r'\[\"(?P<orig>https?://[^\"]+?)\",\s*(?P<orig_h>\d+),\s*(?P<orig_w>\d+)\].*?'
    r'\"2003\":\s*\[null,\s*\"[^\"]*?\",\s*\"(?P<page_url>https?://[^\"]+?)\",\s*\"(?P<title>[^\"]+?)\"',
    re.DOTALL
)

# Dedicated single-thread worker executor for Playwright.
# Playwright and greenlet are tied to the thread where they are created.
# Running all browser operations on this single dedicated thread prevents
# "greenlet.error: Cannot switch to a different thread" completely.
_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="google_images_browser")
_playwright_instance = None
_shared_browser = None
_shared_context = None

# Query cache to provide instant pagination and prevent duplicate scrape requests
_query_cache: Dict[str, Tuple[float, List[Dict[str, Any]]]] = {}
_cache_lock = threading.Lock()
CACHE_TTL = 600.0  # 10 minutes


def _clean_str(s: str) -> str:
    """Safely decodes JSON/unicode escaped characters from Google JS blobs."""
    if not s:
        return ""
    try:
        return json.loads(f'"{s}"')
    except Exception:
        return (
            s.replace(r"\u003d", "=")
            .replace(r"\u0026", "&")
            .replace(r"\u0027", "'")
            .replace(r'\"', '"')
        )


def _worker_get_browser_context():
    """Executed strictly on the dedicated worker thread."""
    global _playwright_instance, _shared_browser, _shared_context
    if not HAS_PLAYWRIGHT:
        return None
    if _shared_context is not None:
        try:
            if _shared_browser and _shared_browser.is_connected():
                return _shared_context
        except Exception:
            pass
    try:
        if _playwright_instance is None:
            _playwright_instance = sync_playwright().start()
        _shared_browser = _playwright_instance.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage"
            ]
        )
        _shared_context = _shared_browser.new_context(
            user_agent=USER_AGENT,
            viewport={"width": 1280, "height": 800}
        )
        return _shared_context
    except Exception as e:
        print(f"[GoogleImagesService] Failed to initialize shared browser: {e}")
        return None


def _build_google_url(
    query: str,
    type_filter: Optional[str] = None,
    aspect_filter: Optional[str] = None,
    color_filter: Optional[str] = None,
    size_filter: Optional[str] = None,
    time_filter: Optional[str] = None,
    page_num: int = 1
) -> str:
    """Constructs Google Images search URL with tbs filter parameters."""
    tbs_parts = []

    # Type
    if type_filter in ("animated", "gif"):
        tbs_parts.append("itp:animated")
    elif type_filter == "clipart":
        tbs_parts.append("itp:clipart")
    elif type_filter == "lineart":
        tbs_parts.append("itp:lineart")

    # Aspect Ratio (wide is optimized for the 64x20 matrix banner)
    if aspect_filter in ("wide", "panoramic"):
        tbs_parts.append("iar:w")
    elif aspect_filter == "square":
        tbs_parts.append("iar:s")
    elif aspect_filter in ("tall", "portrait"):
        tbs_parts.append("iar:t")

    # Color
    if color_filter in ("trans", "transparent"):
        tbs_parts.append("ic:trans")
    elif color_filter in ("gray", "bw", "blackandwhite"):
        tbs_parts.append("ic:gray")
    elif color_filter in (
        "red", "orange", "yellow", "green", "teal", "blue",
        "purple", "pink", "white", "black", "brown"
    ):
        tbs_parts.append(f"ic:specific,isc:{color_filter}")

    # Size
    if size_filter in ("large", "l"):
        tbs_parts.append("isz:l")
    elif size_filter in ("medium", "m"):
        tbs_parts.append("isz:m")
    elif size_filter in ("icon", "i"):
        tbs_parts.append("isz:i")

    # Time
    if time_filter in ("d", "day", "24h"):
        tbs_parts.append("qdr:d")
    elif time_filter in ("w", "week"):
        tbs_parts.append("qdr:w")
    elif time_filter in ("m", "month"):
        tbs_parts.append("qdr:m")
    elif time_filter in ("y", "year"):
        tbs_parts.append("qdr:y")

    search_q = query.strip()
    # When searching specifically for GIFs, include 'gif' in query for optimal animation results
    if type_filter in ("animated", "gif") and "gif" not in search_q.lower():
        search_q = f"{search_q} gif"

    params_str = urllib.parse.urlencode({"q": search_q, "udm": "2"})
    if tbs_parts:
        params_str += f"&tbs={','.join(tbs_parts)}"
    if page_num > 1:
        params_str += f"&start={(page_num - 1) * 20}"

    return f"https://www.google.com/search?{params_str}"


def _worker_scrape_url(url: str, query: str, type_filter: Optional[str] = None) -> List[Dict[str, Any]]:
    """Executed strictly on the dedicated worker thread."""
    context = _worker_get_browser_context()
    if not context:
        return []

    page = None
    items: List[Dict[str, Any]] = []
    seen: set = set()

    try:
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=16000)
        page.wait_for_timeout(1000)
        content = page.content()

        for m in PATTERN.finditer(content):
            d = m.groupdict()
            orig = _clean_str(d["orig"])
            if not orig or orig in seen:
                continue
            seen.add(orig)

            thumb = _clean_str(d["thumb"])
            page_url = _clean_str(d["page_url"])
            title = _clean_str(d["title"])

            domain = ""
            if page_url:
                try:
                    domain = urllib.parse.urlparse(page_url).netloc
                except Exception:
                    domain = ""

            clean_orig_path = orig.lower().split("?")[0]
            # Exclude non-raster formats that cannot be rendered on canvas / sign
            if clean_orig_path.endswith((".svg", ".ico", ".tiff", ".tif", ".bmp")):
                continue

            is_gif = (
                clean_orig_path.endswith(".gif") or
                ".gif?" in orig.lower() or
                "giphy.com" in orig.lower() or
                "tenor.com" in orig.lower()
            )

            # If user requested GIFs, only return genuine animated GIFs
            if type_filter in ("animated", "gif") and not is_gif:
                continue

            items.append({
                "id": d["id"],
                "title": title or query,
                "originalUrl": orig,
                "thumbnailUrl": thumb or orig,
                "width": int(d["orig_w"]) if d["orig_w"].isdigit() else 0,
                "height": int(d["orig_h"]) if d["orig_h"].isdigit() else 0,
                "sourceUrl": page_url,
                "sourceDomain": domain,
                "isAnimated": is_gif,
                "mediaType": "gif" if is_gif else "image"
            })
    except Exception as e:
        print(f"[GoogleImagesService] Scrape error: {e}")
    finally:
        if page:
            try:
                page.close()
            except Exception:
                pass

    return items


def search_google_images(
    query: str,
    type_filter: Optional[str] = None,
    aspect_filter: Optional[str] = None,
    color_filter: Optional[str] = None,
    size_filter: Optional[str] = None,
    time_filter: Optional[str] = None,
    page_num: int = 1,
    max_results: int = 24
) -> List[Dict[str, Any]]:
    """
    Searches Google Images using persistent headless Chromium on a dedicated worker thread,
    with query caching and pagination support.
    """
    if not query or not query.strip():
        return []

    cache_key = f"{query.lower().strip()}|{type_filter or ''}|{aspect_filter or ''}|{color_filter or ''}|{size_filter or ''}|{time_filter or ''}"
    now = time.time()

    with _cache_lock:
        if cache_key in _query_cache:
            cached_time, cached_items = _query_cache[cache_key]
            if now - cached_time < CACHE_TTL:
                start_idx = (page_num - 1) * max_results
                end_idx = start_idx + max_results
                if start_idx < len(cached_items):
                    return cached_items[start_idx:end_idx]

    # Fetch from Google Images
    url = _build_google_url(
        query=query,
        type_filter=type_filter,
        aspect_filter=aspect_filter,
        color_filter=color_filter,
        size_filter=size_filter,
        time_filter=time_filter,
        page_num=page_num
    )

    items: List[Dict[str, Any]] = []
    if HAS_PLAYWRIGHT:
        try:
            future = _executor.submit(_worker_scrape_url, url, query, type_filter)
            items = future.result(timeout=20)
        except Exception as e:
            print(f"[GoogleImagesService] Worker scrape error: {e}")

    # Fallback search if Playwright returns nothing
    if not items:
        try:
            items = _search_fallback(
                query=query,
                type_filter=type_filter,
                aspect_filter=aspect_filter,
                color_filter=color_filter,
                size_filter=size_filter,
                page_num=page_num,
                max_results=max_results
            )
        except Exception as e:
            print(f"[GoogleImagesService] Fallback search error: {e}")

    # Cache items
    if items:
        with _cache_lock:
            if cache_key in _query_cache and page_num > 1:
                cached_time, existing_items = _query_cache[cache_key]
                existing_urls = {i["originalUrl"] for i in existing_items}
                new_unique = [i for i in items if i["originalUrl"] not in existing_urls]
                combined = existing_items + new_unique
                _query_cache[cache_key] = (now, combined)
            else:
                _query_cache[cache_key] = (now, items)

    # Return the requested slice
    if page_num > 1 and len(items) > max_results:
        start_idx = (page_num - 1) * max_results
        end_idx = start_idx + max_results
        return items[start_idx:end_idx] if start_idx < len(items) else items[:max_results]

    return items[:max_results]


def _search_fallback(
    query: str,
    type_filter: Optional[str] = None,
    aspect_filter: Optional[str] = None,
    color_filter: Optional[str] = None,
    size_filter: Optional[str] = None,
    page_num: int = 1,
    max_results: int = 24
) -> List[Dict[str, Any]]:
    """Resilient fallback search to ensure users always receive image results."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }
    qft_parts = []
    if type_filter in ("animated", "gif"):
        qft_parts.append("filterui:photo-animatedgif")
    elif type_filter == "clipart":
        qft_parts.append("filterui:photo-clipart")
    elif type_filter == "lineart":
        qft_parts.append("filterui:photo-linedrawing")

    if aspect_filter in ("wide", "panoramic"):
        qft_parts.append("filterui:aspect-wide")
    elif aspect_filter == "square":
        qft_parts.append("filterui:aspect-square")
    elif aspect_filter in ("tall", "portrait"):
        qft_parts.append("filterui:aspect-tall")

    if color_filter in ("trans", "transparent"):
        qft_parts.append("filterui:color2-transparent")
    elif color_filter in ("gray", "bw", "blackandwhite"):
        qft_parts.append("filterui:color2-bw")
    elif color_filter in ("red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "white", "black"):
        qft_parts.append(f"filterui:color2-{color_filter}")

    if size_filter in ("large", "l"):
        qft_parts.append("filterui:imagesize-large")
    elif size_filter in ("medium", "m"):
        qft_parts.append("filterui:imagesize-medium")
    elif size_filter in ("icon", "i"):
        qft_parts.append("filterui:imagesize-small")

    qft_str = "+".join(f"+{p}" for p in qft_parts) if qft_parts else ""
    search_q = query.strip()
    if type_filter in ("animated", "gif") and "gif" not in search_q.lower():
        search_q = f"{search_q} gif"

    first_index = (page_num - 1) * max_results + 1
    bing_url = f"https://www.bing.com/images/search?q={urllib.parse.quote_plus(search_q)}&first={first_index}"
    if qft_str:
        bing_url += f"&qft={urllib.parse.quote_plus(qft_str)}"

    resp = requests.get(bing_url, headers=headers, timeout=8)
    if resp.status_code != 200:
        return []

    matches = re.findall(r'class="iusc"[^>]*\sm="({.*?})"', resp.text)
    items = []
    seen = set()
    for m_str in matches:
        try:
            unescaped = re.sub(r'&quot;', '"', m_str)
            data = json.loads(unescaped)
            orig = data.get("murl")
            if not orig or orig in seen:
                continue
            seen.add(orig)
            thumb = data.get("turl") or orig
            title = data.get("desc") or data.get("t") or query
            page_url = data.get("purl") or ""
            domain = ""
            if page_url:
                try:
                    domain = urllib.parse.urlparse(page_url).netloc
                except Exception:
                    domain = ""

            clean_url = orig.lower().split("?")[0]
            is_gif = clean_url.endswith(".gif") or ".gif?" in orig.lower() or "giphy.com" in orig.lower() or "tenor.com" in orig.lower()

            # NEVER return static non-GIF files when user requested GIFs!
            if type_filter in ("animated", "gif") and not is_gif:
                continue

            items.append({
                "id": f"img-{len(items)}",
                "title": title,
                "originalUrl": orig,
                "thumbnailUrl": thumb,
                "width": data.get("mw", 0) or 0,
                "height": data.get("mh", 0) or 0,
                "sourceUrl": page_url,
                "sourceDomain": domain,
                "isAnimated": is_gif,
                "mediaType": "gif" if is_gif else "image"
            })
            if len(items) >= max_results:
                break
        except Exception:
            continue
    return items


def proxy_media_content(url: str, timeout: int = 15) -> tuple[bytes, str]:
    """
    Downloads media from external origin with standard headers to bypass hotlinking protections,
    returning (bytes, content_type).
    """
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": "https://www.google.com/"
    }
    resp = requests.get(url, headers=headers, timeout=timeout)
    resp.raise_for_status()
    raw_type = resp.headers.get("Content-Type", "").split(";")[0].strip().lower()

    # Reject HTML error pages or API JSON blocks disguised as 200 OK
    if raw_type.startswith("text/") or raw_type in ("application/json", "application/xml"):
        raise ValueError(f"Origin returned non-image content: {raw_type}")

    data = resp.content
    if len(data) < 16:
        raise ValueError("Empty or truncated image content")

    # Detect real format from binary magic bytes
    if data[:4] in (b'GIF8', b'GIF7'):
        content_type = "image/gif"
    elif data[:8] == b'\x89PNG\r\n\x1a\n':
        content_type = "image/png"
    elif data[:2] == b'\xff\xd8':
        content_type = "image/jpeg"
    elif data[:4] == b'RIFF' and len(data) >= 12 and data[8:12] == b'WEBP':
        content_type = "image/webp"
    elif raw_type.startswith(("image/", "video/")):
        content_type = raw_type
    else:
        ext = url.split("?")[0].split(".")[-1].lower()
        if ext == "gif":
            content_type = "image/gif"
        elif ext in ("jpg", "jpeg"):
            content_type = "image/jpeg"
        elif ext == "png":
            content_type = "image/png"
        elif ext == "mp4":
            content_type = "video/mp4"
        elif ext == "webm":
            content_type = "video/webm"
        else:
            raise ValueError(f"Unrecognized image binary format ({raw_type})")

    return data, content_type
