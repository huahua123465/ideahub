"""工具函数"""
import re
import hashlib
from urllib.parse import parse_qs, urlparse

import httpx


_XHS_SHORT_HOSTS = {"xhslink.cn", "www.xhslink.cn", "xhslink.com", "www.xhslink.com"}
_XHS_HOSTS = {"xiaohongshu.com", "www.xiaohongshu.com", *_XHS_SHORT_HOSTS}


def normalize_url(url: str) -> str:
    """Extract a URL from copied share text and canonicalize supported variants."""
    url = url.strip()
    match = re.search(r"https?://[^\s<>\"']+", url, re.I)
    if match:
        url = match.group(0).rstrip("，。！？、；：,!?;:)]}）】》")
    elif not re.match(r"^https?://", url, re.I):
        return ""
    if "douyin.com" in url.lower():
        modal_id = parse_qs(urlparse(url).query).get("modal_id", [""])[0]
        if re.fullmatch(r"\d{10,}", modal_id):
            return f"https://www.douyin.com/video/{modal_id}"
    return url


def resolve_share_url(url: str, timeout: float = 15.0) -> str:
    """Expand supported mobile share links while preserving their access token."""
    url = normalize_url(url)
    if not url:
        return ""
    host = (urlparse(url).hostname or "").lower()
    if host not in _XHS_SHORT_HOSTS:
        return url
    try:
        with httpx.Client(
            follow_redirects=True,
            timeout=timeout,
            headers={
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 Chrome/125 Safari/537.36"
                ),
            },
        ) as client:
            response = client.get(url)
            response.raise_for_status()
        resolved = normalize_url(str(response.url))
        resolved_host = (urlparse(resolved).hostname or "").lower()
        return resolved if resolved_host in _XHS_HOSTS else url
    except httpx.HTTPError:
        return url


def canonical_content_key(url: str) -> str:
    """Build a stable identity that ignores share tokens and device variants."""
    normalized = normalize_url(url)
    parsed = urlparse(normalized)
    host = (parsed.hostname or "").lower()
    if host in _XHS_HOSTS:
        match = re.search(r"/(?:discovery/item|explore)/([0-9a-f]{16,})", parsed.path, re.I)
        if match:
            return f"xiaohongshu:{match.group(1).lower()}"
    return normalized


def url_to_id(url: str) -> str:
    return hashlib.md5(canonical_content_key(url).encode()).hexdigest()[:12]


def sanitize_filename(name: str, max_len: int = 80) -> str:
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
    return name.strip('. ')[:max_len]


def detect_platform(url: str) -> str:
    mapping = {
        'bilibili.com': 'bilibili', 'b23.tv': 'bilibili',
        'youtube.com': 'youtube', 'youtu.be': 'youtube',
        'douyin.com': 'douyin', 'tiktok.com': 'tiktok',
        'xiaohongshu.com': 'xiaohongshu', 'xhslink.com': 'xiaohongshu',
        'xhslink.cn': 'xiaohongshu',
        'kuaishou.com': 'kuaishou', 'weibo.com': 'weibo',
    }
    for key, val in mapping.items():
        if key in url.lower():
            return val
    return 'unknown'
