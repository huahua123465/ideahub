"""Page extraction: httpx -> Playwright (wait for anti-bot redirect)"""
import html as html_lib
import difflib
import json
import re
from urllib.parse import urljoin
import httpx
from playwright.async_api import async_playwright

from .profile_extractor import extract_account_from_html

BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


async def extract_page(url: str) -> dict | None:
    print(f"  [extract] {url[:80]}")

    # ---- Try httpx ----
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True,
                                      headers=BROWSER_HEADERS, http2=True) as client:
            resp = await client.get(url)
            html = resp.text
        if html and len(html) > 500:
            result = _parse_html(html, str(resp.url))
            if result:
                print(f"  [httpx] OK: {len(result['text'])} chars")
                return result
        print(f"  [httpx] Got {len(html)} chars, need browser")
    except Exception as e:
        print(f"  [httpx] Failed: {e}")

    # ---- Playwright: wait for anti-bot redirect ----
    print(f"  [pw] Launching browser...")
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                viewport={"width": 1280, "height": 800},
                locale="zh-CN",
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            )
            page = await context.new_page()
            # Block heavy resources
            await page.route("**/*.{png,jpg,jpeg,gif,svg,mp4,webm,mp3,woff2,css,ttf,woff}", lambda r: r.abort())

            print(f"  [pw] Navigating...")
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            print(f"  [pw] Initial title: {(await page.title())[:60]}")

            # Wait for anti-bot page to resolve (Sina Visitor System auto-redirects)
            for attempt in range(8):
                await page.wait_for_timeout(2000)
                title = (await page.title()) or ""
                url_now = page.url
                print(f"  [pw] Attempt {attempt+1}: title='{title[:60]}' url='{url_now[:80]}'")

                # Check if we got past the anti-bot wall
                if "Visitor" not in title and "验证" not in title:
                    print(f"  [pw] Anti-bot passed!")
                    break

            # Scroll for lazy content
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight/2)")
            await page.wait_for_timeout(500)
            await page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            await page.wait_for_timeout(1000)

            html = await page.content()
            print(f"  [pw] Final HTML: {len(html)} chars")
            await browser.close()

            result = _parse_html(html, page.url)
            if result:
                print(f"  [pw] Parsed: {len(result['text'])} chars")
                return result
            print(f"  [pw] Parse failed")

    except Exception as e:
        print(f"  [pw] Error: {e}")

    return None


def _meta_content(page_html: str, *, property_name: str = "", name: str = "") -> str:
    key = "property" if property_name else "name"
    value = property_name or name
    patterns = [
        rf'<meta[^>]+{key}=["\']{re.escape(value)}["\'][^>]+content=["\']([^"\']*)',
        rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]+{key}=["\']{re.escape(value)}["\']',
    ]
    for pattern in patterns:
        match = re.search(pattern, page_html, re.I | re.S)
        if match:
            return html_lib.unescape(match.group(1)).strip()
    return ""


def _decode_json_string(value: str) -> str:
    try:
        return json.loads(f'"{value}"')
    except Exception:
        return value.replace(r"\/", "/").replace(r"\u002F", "/")


def _extract_images(page_html: str, base_url: str) -> list[str]:
    candidates = re.findall(
        r'(?:https?:)?(?:\\?/){2}[^"\'<>\s]+?(?:\.jpe?g|\.png|\.webp)(?:\?[^"\'<>\s]*)?',
        page_html,
        re.I,
    )
    candidates += re.findall(
        r'<meta[^>]+property=["\']og:image(?::secure_url)?["\'][^>]+content=["\']([^"\']+)',
        page_html,
        re.I,
    )
    images = []
    seen = set()
    for raw in candidates:
        image_url = html_lib.unescape(_decode_json_string(raw)).replace("\\/", "/")
        if image_url.startswith("//"):
            image_url = "https:" + image_url
        image_url = urljoin(base_url, image_url)
        lower = image_url.lower()
        if any(marker in lower for marker in ("avatar", "logo", "favicon", "emoji", "icon")):
            continue
        if image_url not in seen:
            seen.add(image_url)
            images.append(image_url)
    return images[:30]


def _structured_text(page_html: str) -> list[str]:
    values = []
    for key in ("note_desc", "description", "desc", "content", "title"):
        for match in re.finditer(rf'["\']{key}["\']\s*:\s*["\']((?:\\.|[^"\'])*)["\']', page_html, re.I):
            value = html_lib.unescape(_decode_json_string(match.group(1))).strip()
            if 2 <= len(value) <= 5000 and value not in values:
                values.append(value)
    return values


def _text_fingerprint(value: str) -> str:
    value = re.sub(r"\[话题\]", "", value or "")
    return re.sub(r"[\s\u200b\ufeff]+", "", value).strip()


def _near_duplicate(left: str, right: str, *, threshold: float = 0.96) -> bool:
    left_key, right_key = _text_fingerprint(left), _text_fingerprint(right)
    if not left_key or not right_key:
        return False
    shorter, longer = sorted((left_key, right_key), key=len)
    if shorter in longer and len(shorter) / len(longer) >= 0.72:
        return True
    if min(len(left_key), len(right_key)) < 24:
        return left_key == right_key
    return difflib.SequenceMatcher(None, left_key, right_key).ratio() >= threshold


def _dedupe_text_blocks(
    blocks: list[str], *, description: str = "", title: str = ""
) -> tuple[list[str], bool]:
    """Remove metadata copies and nested/near-duplicate content blocks."""
    unique: list[str] = []
    matched_description = False
    for raw in blocks:
        block = re.sub(r"\s+", " ", raw or "").strip()
        if len(block) < 15 or (title and _near_duplicate(block, title)):
            continue
        if description and _near_duplicate(block, description, threshold=0.92):
            matched_description = True
            continue
        if any(_near_duplicate(block, existing) for existing in unique):
            continue
        unique.append(block)
    return unique, matched_description


def _json_scalar(page_html: str, key: str) -> str:
    match = re.search(
        rf'["\']{re.escape(key)}["\']\s*:\s*(?:["\']((?:\\.|[^"\'])*)["\']|(\d+))',
        page_html,
        re.I,
    )
    if not match:
        return ""
    return html_lib.unescape(_decode_json_string(match.group(1) or match.group(2) or "")).strip()


def _extract_engagement(page_html: str) -> dict[str, str]:
    mappings = {
        "likes": ("og:xhs:note_like", "likedCount"),
        "collects": ("og:xhs:note_collect", "collectedCount"),
        "comments": ("og:xhs:note_comment", "commentCount"),
    }
    return {
        output_key: _meta_content(page_html, property_name=meta_key) or _json_scalar(page_html, json_key)
        for output_key, (meta_key, json_key) in mappings.items()
    }


def _extract_topics(page_html: str, description: str = "") -> list[str]:
    candidates: list[str] = []
    keywords = _meta_content(page_html, name="keywords")
    if keywords:
        candidates.extend(re.split(r"[,，]", keywords))
    candidates.extend(re.findall(r"#([^#\s，。！？；：,]+)", description or ""))
    candidates.extend(
        _decode_json_string(match.group(1))
        for match in re.finditer(
            r'["\']name["\']\s*:\s*["\']((?:\\.|[^"\'])+)["\']\s*,\s*["\']type["\']\s*:\s*["\']topic["\']',
            page_html,
            re.I,
        )
    )
    topics: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        topic = re.sub(r"\[话题\]$", "", html_lib.unescape(candidate)).strip().lstrip("#")
        key = _text_fingerprint(topic).casefold()
        if 1 < len(topic) <= 60 and key and key not in seen:
            seen.add(key)
            topics.append(topic)
    return topics[:20]


def clean_post_title(value: str) -> str:
    title = html_lib.unescape(value or "").strip()
    title = re.sub(r"\s*[-|_]\s*(?:小红书|抖音)\s*$", "", title, flags=re.I)
    return title.strip()


def strip_topics_from_description(description: str, topics: list[str]) -> str:
    """Return the authored description without repeating structured hashtags."""
    cleaned = html_lib.unescape(description or "")
    for topic in sorted((item for item in topics if item), key=len, reverse=True):
        # Some downloader payloads omit the first leading '#', but retain the
        # platform's explicit [话题] marker. Remove that structured form without
        # deleting ordinary prose that happens to mention the same word.
        cleaned = re.sub(
            rf"(?:#\s*)?{re.escape(topic)}\s*\[话题\]\s*#?",
            " ",
            cleaned,
            flags=re.I,
        )
        cleaned = re.sub(
            rf"#\s*{re.escape(topic)}(?:\[话题\])?#?",
            " ",
            cleaned,
            flags=re.I,
        )
    cleaned = re.sub(r"(?:\s*#\s*)+$", "", cleaned)
    return re.sub(r"\s+", " ", cleaned).strip(" #|丨")


def _parse_html(html: str, url: str = "") -> dict | None:
    if not html or len(html) < 200:
        return None

    original_html = html
    title = _meta_content(original_html, property_name="og:title")
    for pattern in [
        r'<title[^>]*>(.*?)</title>',
        r'<meta\s+property="og:title"\s+content="([^"]+)"',
    ]:
        m = re.search(pattern, html, re.I | re.S)
        if m:
            if title:
                break
            title = html_lib.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
            title = re.sub(r"\s*[-|_]\s*.+$", "", title)
            if len(title) > 3: break

    for tag in ["script","style","nav","footer","header","iframe","noscript","svg"]:
        html = re.sub(rf"<{tag}[\s\S]*?</{tag}>", "", html, flags=re.I)

    title = clean_post_title(title)
    raw_description = (_meta_content(original_html, property_name="og:description") or
                       _meta_content(original_html, name="description"))
    engagement = _extract_engagement(original_html)
    topics = _extract_topics(original_html, raw_description)
    description = strip_topics_from_description(raw_description, topics)
    text_blocks = _structured_text(original_html)
    for m in re.finditer(
        r"<(?:p|article|div|section|h[1-6]|li|span|blockquote|pre|td|dd)[^>]*>(.*?)</(?:p|article|div|section|h[1-6]|li|span|blockquote|pre|td|dd)>",
        html, re.I | re.S
    ):
        block = html_lib.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip()
        block = re.sub(r"\s+", " ", block)
        if len(block) > 15 and not block.startswith("{"):
            if block not in text_blocks:
                text_blocks.append(block)

    text_blocks, text_same_as_description = _dedupe_text_blocks(
        text_blocks, description=description, title=title
    )
    text = "\n\n".join(text_blocks)

    if len(text) < 200:
        body_m = re.search(r"<body[\s\S]*?</body>", html, re.I)
        if body_m:
            body = body_m.group(0)
            for tag in ["script","style","nav","footer","header","iframe","noscript","svg"]:
                body = re.sub(rf"<{tag}[\s\S]*?</{tag}>", "", body, flags=re.I)
            body = re.sub(r"<[^>]+>", " ", body)
            body = re.sub(r"\s+", " ", body).strip()
            if len(body) > len(text):
                text = body

    if description and _near_duplicate(text, description, threshold=0.92):
        text = ""
        text_same_as_description = True
    images = _extract_images(original_html, url)
    url_key = (url or "").casefold()
    platform = (
        "xiaohongshu" if any(host in url_key for host in ("xiaohongshu.com", "xhslink.com", "xhslink.cn"))
        else "douyin" if "douyin.com" in url_key
        else ""
    )
    account = extract_account_from_html(original_html, platform)

    if not text and not title and not description and not images:
        return None

    return {
        "title": title or "未命名内容",
        "description": description,
        "post_title": title or "未命名内容",
        "post_description": description,
        "text": text,
        "text_same_as_description": text_same_as_description,
        "engagement": engagement,
        "topics": topics,
        "images": images,
        "account": account,
        "duration": 0.0,
    }
