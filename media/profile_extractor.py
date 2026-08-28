"""Bounded creator-profile extraction for Xiaohongshu and Douyin.

Only values exposed by the platform page or downloader metadata are returned.
Missing fields intentionally remain empty strings.
"""
from __future__ import annotations

import asyncio
import html as html_lib
import json
import re
import time
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote

import httpx
from playwright.async_api import async_playwright


ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
COOKIE_FILES = {
    "xiaohongshu": DATA_DIR / "xiaohongshu.cookies.txt",
    "douyin": DATA_DIR / "douyin.cookies.txt",
}
XHS_STORAGE_STATE = DATA_DIR / "xiaohongshu.storage_state.json"
ACCOUNT_HTTP_ATTEMPTS = 3
ACCOUNT_RETRY_BASE_SECONDS = 0.5

ACCOUNT_FIELDS = (
    "name",
    "profile_url",
    "bio",
    "following_count",
    "follower_count",
    "likes_and_collections_count",
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}


def empty_account() -> dict[str, str]:
    """Return the stable public account contract with deliberately blank values."""
    return {field: "" for field in ACCOUNT_FIELDS}


def normalize_account(value: Any) -> dict[str, str]:
    """Keep the account contract stable without inventing missing values."""
    result = empty_account()
    if not isinstance(value, dict):
        return result
    for field in ACCOUNT_FIELDS:
        scalar = value.get(field)
        if scalar is None or isinstance(scalar, (dict, list, tuple, set, bool)):
            continue
        if isinstance(scalar, float) and scalar.is_integer():
            scalar = int(scalar)
        result[field] = str(scalar).strip()
    if result["profile_url"] and not result["profile_url"].startswith(("http://", "https://")):
        result["profile_url"] = ""
    return result


def merge_accounts(*accounts: Any) -> dict[str, str]:
    """Merge in priority order, filling blanks only."""
    result = empty_account()
    for account in accounts:
        normalized = normalize_account(account)
        for field in ACCOUNT_FIELDS:
            if not result[field] and normalized[field]:
                result[field] = normalized[field]
    return result


def _scalar(mapping: Any, *keys: str) -> str:
    if not isinstance(mapping, dict):
        return ""
    for key in keys:
        if key not in mapping:
            continue
        value = mapping.get(key)
        if value is None or isinstance(value, (dict, list, tuple, set, bool)):
            continue
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        return str(value).strip()
    return ""


def _replace_js_undefined(value: str) -> str:
    value = re.sub(r"(?<=:)\s*undefined(?=\s*[,}])", "null", value)
    return re.sub(r"(?<=\[|,)\s*undefined(?=\s*[,\]])", "null", value)


def _decode_json_object(value: str) -> Any:
    value = html_lib.unescape(value).strip().rstrip(";")
    value = _replace_js_undefined(value)
    try:
        return json.loads(value, strict=False)
    except (json.JSONDecodeError, TypeError):
        try:
            return json.JSONDecoder(strict=False).raw_decode(value)[0]
        except (json.JSONDecodeError, TypeError):
            return None


def _initial_state(page_html: str) -> Any:
    marker = re.search(r"window\.__INITIAL_STATE__\s*=\s*", page_html)
    if not marker:
        return None
    tail = page_html[marker.end():]
    start = min((position for position in (tail.find("{"), tail.find("[")) if position >= 0), default=-1)
    if start < 0:
        return None
    return _decode_json_object(tail[start:])


def _render_data(page_html: str) -> Any:
    match = re.search(
        r'<script[^>]+id=["\']RENDER_DATA["\'][^>]*>(.*?)</script>',
        page_html,
        re.I | re.S,
    )
    if not match:
        return None
    return _decode_json_object(unquote(html_lib.unescape(match.group(1))))


def _iter_dicts(value: Any, path: tuple[str, ...] = ()) -> Iterable[tuple[tuple[str, ...], dict]]:
    if isinstance(value, dict):
        yield path, value
        for key, child in value.items():
            yield from _iter_dicts(child, (*path, str(key)))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _iter_dicts(child, (*path, str(index)))


def _interaction_counts(interactions: Any) -> dict[str, str]:
    counts = {"following_count": "", "follower_count": "", "likes_and_collections_count": ""}
    if not isinstance(interactions, list):
        return counts
    aliases = {
        "following_count": {"follows", "follow", "following", "关注"},
        "follower_count": {"fans", "followers", "follower", "粉丝"},
        "likes_and_collections_count": {
            "interaction", "interactions", "likedandcollected", "likesandcollections",
            "获赞与收藏", "获赞和收藏",
        },
    }
    for item in interactions:
        if not isinstance(item, dict):
            continue
        identity = (_scalar(item, "type", "name", "label") or "").replace(" ", "").casefold()
        count = _scalar(item, "count", "value", "num")
        for field, names in aliases.items():
            if identity in {name.casefold() for name in names}:
                counts[field] = count
                break
    return counts


def _xhs_profile_from_state(state: Any) -> dict[str, str]:
    if not isinstance(state, dict):
        return empty_account()
    user_root = state.get("user") or {}
    page_data = (user_root.get("userPageData") or user_root.get("user_page_data") or {})
    if not isinstance(page_data, dict):
        return empty_account()
    basic = page_data.get("basicInfo") or page_data.get("basic_info") or page_data
    user_id = _scalar(basic, "userId", "user_id") or _scalar(page_data, "userId", "user_id")
    counts = _interaction_counts(page_data.get("interactions"))
    return normalize_account({
        "name": _scalar(basic, "nickname", "nickName", "nick_name", "name"),
        "profile_url": f"https://www.xiaohongshu.com/user/profile/{user_id}" if user_id else "",
        "bio": _scalar(basic, "desc", "description", "bio"),
        **counts,
    })


def _xhs_note_from_state(state: Any) -> dict[str, str]:
    if not isinstance(state, dict):
        return empty_account()

    note_root = state.get("note") or {}
    detail_map = note_root.get("noteDetailMap") or note_root.get("note_detail_map") or {}
    candidates: list[dict] = []
    if isinstance(detail_map, dict):
        for detail in detail_map.values():
            if not isinstance(detail, dict):
                continue
            note = detail.get("note") if isinstance(detail.get("note"), dict) else detail
            user = note.get("user") if isinstance(note, dict) else None
            if isinstance(user, dict):
                candidates.append(user)

    if not candidates:
        scored: list[tuple[int, dict]] = []
        for path, item in _iter_dicts(state):
            nickname = _scalar(item, "nickname", "nickName", "nick_name")
            user_id = _scalar(item, "userId", "user_id")
            if not nickname or not user_id:
                continue
            path_text = "/".join(path).casefold()
            score = 2 + (4 if "notedetailmap" in path_text or "note_detail_map" in path_text else 0)
            score += 2 if "notecard" in path_text or "note_card" in path_text else 0
            scored.append((score, item))
        if scored:
            candidates.append(max(scored, key=lambda pair: pair[0])[1])

    if not candidates:
        return empty_account()
    user = candidates[0]
    user_id = _scalar(user, "userId", "user_id", "secUid", "sec_uid")
    return normalize_account({
        "name": _scalar(user, "nickname", "nickName", "nick_name", "name"),
        "profile_url": f"https://www.xiaohongshu.com/user/profile/{user_id}" if user_id else "",
    })


def _douyin_from_state(state: Any) -> dict[str, str]:
    if not isinstance(state, (dict, list)):
        return empty_account()
    candidates: list[tuple[int, dict]] = []
    for path, item in _iter_dicts(state):
        name = _scalar(item, "nickname", "nickName", "name")
        if not name:
            continue
        score = 0
        score += 3 if _scalar(item, "sec_uid", "secUid") else 0
        score += 4 if _scalar(item, "follower_count", "followerCount") else 0
        score += 3 if _scalar(item, "following_count", "followingCount") else 0
        score += 4 if _scalar(item, "total_favorited", "totalFavorited") else 0
        score += 2 if _scalar(item, "signature", "desc", "bio") else 0
        path_text = "/".join(path).casefold()
        score += 3 if "authorinfo" in path_text or path_text.endswith("/author") else 0
        candidates.append((score, item))
    if not candidates:
        return empty_account()
    user = max(candidates, key=lambda pair: pair[0])[1]
    sec_uid = _scalar(user, "sec_uid", "secUid")
    return normalize_account({
        "name": _scalar(user, "nickname", "nickName", "name"),
        "profile_url": f"https://www.douyin.com/user/{sec_uid}" if sec_uid else "",
        "bio": _scalar(user, "signature", "desc", "bio"),
        "following_count": _scalar(user, "following_count", "followingCount"),
        "follower_count": _scalar(user, "follower_count", "followerCount"),
        "likes_and_collections_count": _scalar(user, "total_favorited", "totalFavorited"),
    })


def extract_account_from_html(page_html: str, platform: str) -> dict[str, str]:
    """Extract only platform-supplied account values from a page snapshot."""
    if not page_html:
        return empty_account()
    if platform == "xiaohongshu":
        state = _initial_state(page_html)
        return merge_accounts(_xhs_profile_from_state(state), _xhs_note_from_state(state))
    if platform == "douyin":
        return merge_accounts(_douyin_from_state(_render_data(page_html)), _douyin_from_state(_initial_state(page_html)))
    return empty_account()


def account_from_downloader(meta: Any) -> dict[str, str]:
    """Map trustworthy downloader metadata to the shared account contract."""
    if not isinstance(meta, dict):
        return empty_account()
    profile_url = meta.get("uploader_url") or meta.get("channel_url") or ""
    webpage_url = str(meta.get("webpage_url") or "").casefold()
    uploader_id = str(meta.get("uploader_id") or "").strip()
    if not profile_url and uploader_id:
        if "xiaohongshu.com" in webpage_url:
            profile_url = f"https://www.xiaohongshu.com/user/profile/{uploader_id}"
        elif "douyin.com" in webpage_url:
            profile_url = f"https://www.douyin.com/user/{uploader_id}"
    return normalize_account({
        "name": meta.get("uploader"),
        "profile_url": profile_url,
        "follower_count": meta.get("channel_follower_count"),
    })


def _netscape_cookies(platform: str) -> list[dict[str, Any]]:
    cookie_file = COOKIE_FILES.get(platform)
    if not cookie_file or not cookie_file.exists():
        return []
    cookies: list[dict[str, Any]] = []
    try:
        lines = cookie_file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    now = int(time.time())
    for line in lines:
        http_only = line.startswith("#HttpOnly_")
        if line.startswith("#") and not http_only:
            continue
        if http_only:
            line = line[len("#HttpOnly_"):]
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _, path, secure, expires, name, value = parts[:7]
        try:
            expiry = int(expires or 0)
        except ValueError:
            expiry = 0
        if expiry and expiry < now:
            continue
        cookies.append({
            "name": name,
            "value": value,
            "domain": domain,
            "path": path or "/",
            "secure": secure.upper() == "TRUE",
            "httpOnly": http_only,
            **({"expires": expiry} if expiry else {}),
        })
    return cookies


def _cookie_header(platform: str) -> str:
    return "; ".join(f"{item['name']}={item['value']}" for item in _netscape_cookies(platform))


async def _http_html(url: str, platform: str) -> str:
    headers = dict(HEADERS)
    cookie_header = _cookie_header(platform)
    if cookie_header:
        headers["Cookie"] = cookie_header
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True, headers=headers, http2=True) as client:
            response = await client.get(url)
            return response.text if response.status_code < 500 else ""
    except Exception:
        return ""


async def _browser_html(url: str, platform: str) -> str:
    """Use the saved local session only as a bounded fallback for SSR hydration."""
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            context_options: dict[str, Any] = {
                "viewport": {"width": 1280, "height": 800},
                "locale": "zh-CN",
                "user_agent": HEADERS["User-Agent"],
            }
            if platform == "xiaohongshu" and XHS_STORAGE_STATE.exists():
                context_options["storage_state"] = str(XHS_STORAGE_STATE)
            context = await browser.new_context(**context_options)
            if "storage_state" not in context_options:
                cookies = _netscape_cookies(platform)
                if cookies:
                    await context.add_cookies(cookies)
            page = await context.new_page()
            await page.route(
                "**/*.{png,jpg,jpeg,gif,svg,mp4,webm,mp3,woff2,css,ttf,woff}",
                lambda route: route.abort(),
            )
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(1800)
            content = await page.content()
            await browser.close()
            return content
    except Exception:
        return ""


def _has_profile_details(account: dict[str, str]) -> bool:
    return any(account.get(field) for field in (
        "bio", "following_count", "follower_count", "likes_and_collections_count"
    ))


async def _retry_http_account(
    url: str,
    platform: str,
    *,
    require_profile_details: bool,
) -> dict[str, str]:
    """Retry empty platform snapshots without multiplying browser instances."""
    best = empty_account()
    for attempt in range(ACCOUNT_HTTP_ATTEMPTS):
        page_html = await _http_html(url, platform)
        best = merge_accounts(best, extract_account_from_html(page_html, platform))
        ready = _has_profile_details(best) if require_profile_details else bool(best["profile_url"])
        if ready:
            break
        if attempt + 1 < ACCOUNT_HTTP_ATTEMPTS:
            await asyncio.sleep(ACCOUNT_RETRY_BASE_SECONDS * (2 ** attempt))
    return best


async def hydrate_account(source_url: str, platform: str, seed: Any = None) -> dict[str, str]:
    """Resolve a creator page and fill only values actually returned by the platform."""
    account = normalize_account(seed)
    if platform not in {"xiaohongshu", "douyin"}:
        return account

    if not account["profile_url"]:
        source_account = await _retry_http_account(
            source_url, platform, require_profile_details=False
        )
        account = merge_accounts(account, source_account)
        if not account["profile_url"]:
            browser_source = await _browser_html(source_url, platform)
            account = merge_accounts(account, extract_account_from_html(browser_source, platform))

    profile_url = account["profile_url"]
    if not profile_url:
        return account

    profile_account = await _retry_http_account(
        profile_url, platform, require_profile_details=True
    )
    account = merge_accounts(profile_account, account)
    if not _has_profile_details(account):
        browser_profile = await _browser_html(profile_url, platform)
        account = merge_accounts(extract_account_from_html(browser_profile, platform), account)
    return normalize_account(account)
