"""yt-dlp video downloader + metadata extraction"""
import subprocess
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
from config import (
    DATA_DIR,
    COLLECTOR_DOWNLOAD_TIMEOUT_SEC,
    COLLECTOR_MAX_DOWNLOAD_MB,
    MAX_VIDEO_DURATION,
)
from security import UnsafeUrl, fetch_safe_bytes, safe_egress_proxy, validate_public_url

COOKIE_FILES = {
    "douyin.com": DATA_DIR / "douyin.cookies.txt",
    "xiaohongshu.com": DATA_DIR / "xiaohongshu.cookies.txt",
    "xhslink.com": DATA_DIR / "xiaohongshu.cookies.txt",
}
METADATA_PROBE_ATTEMPTS = 3
METADATA_RETRY_BASE_SECONDS = 0.75


def _probe_downloaded_duration(video_path: str) -> float:
    """Return a finite positive duration from the bytes that were downloaded."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", video_path,
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        duration = float(result.stdout.strip()) if result.returncode == 0 else 0.0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        duration = 0.0
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("下载后无法验证视频时长")
    return duration


def _cookie_args(url: str, *, use_login: bool = True) -> list[str]:
    """Use a local, git-ignored cookie file for sites that require browser state."""
    if not use_login:
        return []
    for host, cookie_file in COOKIE_FILES.items():
        if host in url.lower() and cookie_file.exists():
            return ["--cookies", str(cookie_file)]
    return []


def url_declares_video(url: str) -> bool:
    """Return true only for explicit, platform-supplied video URL signals."""
    parsed = urlparse(str(url or ""))
    query_type = (parse_qs(parsed.query).get("type") or [""])[0].casefold()
    if query_type == "video":
        return True
    path_parts = {part.casefold() for part in parsed.path.split("/") if part}
    return bool(path_parts & {"video", "videos"})


def download_video(
    url: str, output_dir: str, metadata: dict | None = None, *,
    use_login: bool = True,
) -> dict | None:
    validate_public_url(url)
    os.makedirs(output_dir, exist_ok=True)
    output_template = os.path.join(output_dir, "%(title).80s_%(id)s.%(ext)s")

    meta = metadata if metadata is not None else extract_video_metadata(
        url, use_login=use_login,
    )
    meta = meta or {}
    if float(meta.get("duration") or 0) > MAX_VIDEO_DURATION:
        raise ValueError(f"视频时长超过 {MAX_VIDEO_DURATION} 秒限制")
    if int(meta.get("filesize") or 0) > COLLECTOR_MAX_DOWNLOAD_MB * 1024 * 1024:
        raise ValueError(f"媒体文件超过 {COLLECTOR_MAX_DOWNLOAD_MB}MB 限制")

    print("  downloading validated platform video...")

    cmd = [
        "yt-dlp", "--no-playlist",
        *_cookie_args(url, use_login=use_login),
        # Caption extraction does not benefit from downloading the largest
        # rendition. A native 720px portrait stream keeps text clear while
        # reducing CDN stalls and temporary processing time substantially.
        "--format", "best[width<=720][height<=1280]/best[width<=1080][height<=1920]/best",
        "--socket-timeout", "20",
        "--retries", "3",
        "--max-filesize", f"{COLLECTOR_MAX_DOWNLOAD_MB}M",
        "--merge-output-format", "mp4",
        "--output", output_template,
        "--quiet", "--no-warnings",
        url
    ]
    try:
        with safe_egress_proxy() as proxy_url:
            subprocess.run(
                [*cmd[:-1], "--proxy", proxy_url, cmd[-1]],
                check=True,
                timeout=COLLECTOR_DOWNLOAD_TIMEOUT_SEC,
            )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print(f"  download failed ({e.__class__.__name__})")
        return None

    video_files = sorted(Path(output_dir).glob("*.mp4"), key=os.path.getmtime, reverse=True)
    if not video_files:
        print("  no video file found")
        return None

    video_path = str(video_files[0])
    if Path(video_path).stat().st_size > COLLECTOR_MAX_DOWNLOAD_MB * 1024 * 1024:
        Path(video_path).unlink(missing_ok=True)
        raise ValueError(f"媒体文件超过 {COLLECTOR_MAX_DOWNLOAD_MB}MB 限制")
    try:
        verified_duration = _probe_downloaded_duration(video_path)
    except ValueError:
        Path(video_path).unlink(missing_ok=True)
        raise
    if verified_duration > MAX_VIDEO_DURATION:
        Path(video_path).unlink(missing_ok=True)
        raise ValueError(f"视频时长超过 {MAX_VIDEO_DURATION} 秒限制")
    print("  video saved and verified")
    return {
        "video_path": video_path,
        "id": meta.get("id", ""),
        "title": meta.get("title", ""),
        "description": meta.get("description", ""),
        "duration": verified_duration,
        "width": meta.get("width", 0),
        "height": meta.get("height", 0),
        "format": meta.get("format", ""),
        "vcodec": meta.get("vcodec", ""),
        "uploader": meta.get("uploader", ""),
        "uploader_id": meta.get("uploader_id", ""),
        "uploader_url": meta.get("uploader_url", ""),
        "channel_url": meta.get("channel_url", ""),
        "channel_follower_count": meta.get("channel_follower_count"),
        "webpage_url": meta.get("webpage_url", url),
        "published_at": meta.get("published_at", ""),
    }


def _published_at_from_payload(data: dict) -> str:
    timestamp = data.get("timestamp") or data.get("release_timestamp")
    try:
        if timestamp:
            return datetime.fromtimestamp(float(timestamp), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError):
        pass
    upload_date = str(data.get("upload_date") or "").strip()
    try:
        if len(upload_date) == 8 and upload_date.isdigit():
            return datetime.strptime(upload_date, "%Y%m%d").replace(
                tzinfo=timezone.utc
            ).isoformat()
    except ValueError:
        pass
    return ""


def _metadata_from_payload(data: dict, url: str) -> dict:
    return {
        "id": data.get("id", ""),
        "title": data.get("title", ""),
        "description": data.get("description", ""),
        "tags": data.get("tags") or [],
        "duration": data.get("duration", 0),
        "uploader": data.get("uploader", ""),
        "uploader_id": data.get("uploader_id", ""),
        "uploader_url": data.get("uploader_url", ""),
        "channel_url": data.get("channel_url", ""),
        "channel_follower_count": data.get("channel_follower_count"),
        "like_count": data.get("like_count"),
        "comment_count": data.get("comment_count"),
        "repost_count": data.get("repost_count"),
        "view_count": data.get("view_count"),
        "published_at": _published_at_from_payload(data),
        "thumbnail": data.get("thumbnail", ""),
        "webpage_url": data.get("webpage_url", url),
        # Platform CDN URLs may expire. Keep them as optional playback hints
        # while treating webpage_url as the durable source link.
        "direct_url": data.get("url", ""),
        "width": data.get("width") or 0,
        "height": data.get("height") or 0,
        "filesize": data.get("filesize") or data.get("filesize_approx") or 0,
        "format": data.get("format", ""),
        "vcodec": data.get("vcodec", ""),
    }


def extract_video_metadata(
    url: str, attempts: int = METADATA_PROBE_ATTEMPTS, *,
    use_login: bool = True,
) -> dict | None:
    """Read platform metadata with bounded retries for transient extractor failures."""
    validate_public_url(url)
    cmd = [
        "yt-dlp", "--dump-json", "--no-playlist", "--quiet",
        *_cookie_args(url, use_login=use_login), url,
    ]
    attempts = max(1, int(attempts))
    for attempt in range(attempts):
        try:
            with safe_egress_proxy() as proxy_url:
                result = subprocess.run(
                    [*cmd[:-1], "--proxy", proxy_url, cmd[-1]],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
            if result.returncode == 0 and result.stdout.strip():
                data = json.loads(result.stdout)
                if isinstance(data, dict):
                    return _metadata_from_payload(data, url)
        except (OSError, json.JSONDecodeError, subprocess.TimeoutExpired):
            pass
        if attempt + 1 < attempts:
            time.sleep(METADATA_RETRY_BASE_SECONDS * (2 ** attempt))
    print(f"  metadata unavailable after {attempts} attempts")
    return None


def download_video_cover(url: str, output_dir: str, referer: str = "") -> str | None:
    """Download a platform-provided video cover for temporary OCR processing."""
    if not url:
        return None
    try:
        validate_public_url(url, media=True)
    except UnsafeUrl:
        return None
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 Chrome/125 Safari/537.36"
        ),
        **({"Referer": referer} if referer else {}),
    }
    try:
        content, response_headers, _ = fetch_safe_bytes(
            url,
            max_bytes=min(COLLECTOR_MAX_DOWNLOAD_MB, 25) * 1024 * 1024,
            headers=headers,
        )
        content_type = response_headers.get("content-type", "").casefold()
        if not content_type.startswith("image/") or len(content) < 1024:
            return None
        suffix = ".png" if "png" in content_type else ".webp" if "webp" in content_type else ".jpg"
        cover_path = output_path / f"video_cover{suffix}"
        cover_path.write_bytes(content)
        return str(cover_path)
    except (httpx.HTTPError, UnsafeUrl, OSError, ValueError) as exc:
        print(f"  video cover download failed safely ({exc.__class__.__name__})")
        return None


# Backwards-compatible private name used by older callers.
_extract_meta = extract_video_metadata
