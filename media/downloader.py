"""yt-dlp video downloader + metadata extraction"""
import subprocess
import json
import os
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx


DATA_DIR = Path(__file__).resolve().parent.parent / "data"
COOKIE_FILES = {
    "douyin.com": DATA_DIR / "douyin.cookies.txt",
    "xiaohongshu.com": DATA_DIR / "xiaohongshu.cookies.txt",
    "xhslink.com": DATA_DIR / "xiaohongshu.cookies.txt",
}
METADATA_PROBE_ATTEMPTS = 3
METADATA_RETRY_BASE_SECONDS = 0.75


def _cookie_args(url: str) -> list[str]:
    """Use a local, git-ignored cookie file for sites that require browser state."""
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


def download_video(url: str, output_dir: str, metadata: dict | None = None) -> dict | None:
    os.makedirs(output_dir, exist_ok=True)
    output_template = os.path.join(output_dir, "%(title).80s_%(id)s.%(ext)s")

    meta = metadata if metadata is not None else extract_video_metadata(url)
    meta = meta or {}

    title = meta.get("title", url)[:60]
    print(f"  downloading: {title}...")

    cmd = [
        "yt-dlp", "--no-playlist",
        *_cookie_args(url),
        # Caption extraction does not benefit from downloading the largest
        # rendition. A native 720px portrait stream keeps text clear while
        # reducing CDN stalls and temporary processing time substantially.
        "--format", "best[width<=720][height<=1280]/best[width<=1080][height<=1920]/best",
        "--downloader", "curl",
        "--socket-timeout", "20",
        "--retries", "3",
        "--merge-output-format", "mp4",
        "--output", output_template,
        "--quiet", "--no-warnings",
        url
    ]
    try:
        subprocess.run(cmd, check=True, timeout=600)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print(f"  download failed: {e}")
        return None

    video_files = sorted(Path(output_dir).glob("*.mp4"), key=os.path.getmtime, reverse=True)
    if not video_files:
        print("  no video file found")
        return None

    video_path = str(video_files[0])
    print(f"  saved: {os.path.basename(video_path)}")
    return {
        "video_path": video_path,
        "title": meta.get("title", ""),
        "description": meta.get("description", ""),
        "duration": meta.get("duration", 0),
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
    }


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
    url: str, attempts: int = METADATA_PROBE_ATTEMPTS
) -> dict | None:
    """Read platform metadata with bounded retries for transient extractor failures."""
    cmd = ["yt-dlp", "--dump-json", "--no-playlist", "--quiet", *_cookie_args(url), url]
    attempts = max(1, int(attempts))
    for attempt in range(attempts):
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
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
        response = httpx.get(url, headers=headers, follow_redirects=True, timeout=20)
        content_type = response.headers.get("content-type", "").casefold()
        if response.status_code != 200 or not content_type.startswith("image/") or len(response.content) < 1024:
            return None
        suffix = ".png" if "png" in content_type else ".webp" if "webp" in content_type else ".jpg"
        cover_path = output_path / f"video_cover{suffix}"
        cover_path.write_bytes(response.content)
        return str(cover_path)
    except Exception as exc:
        print(f"  video cover download failed: {exc}")
        return None


# Backwards-compatible private name used by older callers.
_extract_meta = extract_video_metadata
