"""Continuous video-text extraction through a native video model.

The source video is temporary. It is compressed into short, overlapping chunks,
sent as base64 video input, and removed with the pipeline working directory.
No API key, video bytes, or provider response body is written to logs.
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from config import (
    MOXUS_API_KEY,
    MOXUS_BASE_URL,
    MOXUS_VIDEO_MODEL,
    OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL,
    OPENROUTER_VIDEO_MODEL,
    VIDEO_MODEL_PROVIDER,
    VIDEO_MODEL_CHUNK_OVERLAP,
    VIDEO_MODEL_CHUNK_SECONDS,
    VIDEO_MODEL_FPS,
    VIDEO_MODEL_MAX_CHUNKS,
    VIDEO_MODEL_REQUEST_RETRIES,
    VIDEO_MODEL_WIDTH,
)
from security import redact_sensitive_text


_PROMPT = """你是视频字幕逐字提取器。请完整观看这段视频，而不是按固定时间间隔抽图。
任务：提取画面中承载口播或叙事内容的每一次字幕/文案变化，并给出它第一次清晰出现的时间。
要求：
1. 不总结、不改写、不补写；尽量保留原字、标点和语序。
2. 连续字幕每发生一次新增、替换或换句，都单独记录，不能只取每 3 秒的画面。
3. 忽略账号水印、点赞评论按钮、进度条、系统 UI 和长期不变的装饰文字。
4. 音频只可用于辨认模糊字，不得凭音频虚构画面上没有出现的文字。
5. 时间以当前视频片段开头为 0 秒，允许小数。
只返回 JSON 对象，不要 Markdown：
{"segments":[{"start_seconds":0.0,"text":"画面文字"}]}"""


def _provider_config() -> dict:
    providers = {
        "moxus": {
            "provider": "moxus",
            "api_key": MOXUS_API_KEY,
            "base_url": MOXUS_BASE_URL,
            "model": MOXUS_VIDEO_MODEL,
        },
        "openrouter": {
            "provider": "openrouter",
            "api_key": OPENROUTER_API_KEY,
            "base_url": OPENROUTER_BASE_URL,
            "model": OPENROUTER_VIDEO_MODEL,
        },
    }
    preferred = VIDEO_MODEL_PROVIDER if VIDEO_MODEL_PROVIDER in providers else "moxus"
    for name in (preferred, *(item for item in providers if item != preferred)):
        if providers[name]["api_key"]:
            return providers[name]
    return providers[preferred]


def _base_result(status: str, provider: dict, message: str = "") -> dict:
    return {
        "text": "",
        "status": status,
        "method": f"{provider['provider']}_video",
        "provider": provider["provider"],
        "model": provider["model"],
        "chunks_total": 0,
        "chunks_succeeded": 0,
        "chunk_seconds": VIDEO_MODEL_CHUNK_SECONDS,
        "overlap_seconds": VIDEO_MODEL_CHUNK_OVERLAP,
        "fps": VIDEO_MODEL_FPS,
        "message": message,
    }


def _probe_duration(video_path: str) -> float:
    command = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", video_path,
    ]
    try:
        result = subprocess.run(
            command, check=True, capture_output=True, text=True, timeout=30,
        )
        return max(0.0, float(result.stdout.strip()))
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return 0.0


def _build_chunk_starts(
    duration: float,
    chunk_seconds: int = VIDEO_MODEL_CHUNK_SECONDS,
    overlap_seconds: int = VIDEO_MODEL_CHUNK_OVERLAP,
    max_chunks: int = VIDEO_MODEL_MAX_CHUNKS,
) -> list[float]:
    if duration <= 0 or chunk_seconds <= 0 or max_chunks <= 0:
        return []
    step = max(1, chunk_seconds - max(0, overlap_seconds))
    starts: list[float] = []
    current = 0.0
    while current < duration and len(starts) < max_chunks:
        starts.append(round(current, 3))
        current += step
    return starts


def _encode_chunk(
    video_path: str,
    output_path: Path,
    start_seconds: float,
    duration_seconds: float,
) -> bool:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-y", "-ss", f"{start_seconds:.3f}", "-i", video_path,
        "-t", f"{duration_seconds:.3f}",
        "-vf", f"fps={VIDEO_MODEL_FPS},scale={VIDEO_MODEL_WIDTH}:-2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "48k", "-ac", "1",
        "-map_metadata", "-1", "-movflags", "+faststart", str(output_path),
    ]
    try:
        subprocess.run(
            command,
            check=True,
            capture_output=True,
            timeout=max(120, int(duration_seconds * 4)),
        )
        return output_path.exists() and output_path.stat().st_size > 0
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


def _message_text(payload: dict) -> str:
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            str(item.get("text") or "")
            for item in content
            if isinstance(item, dict) and item.get("type") in {"text", "output_text"}
        )
    return ""


def _json_value(text: str) -> dict | list:
    cleaned = str(text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        value = json.loads(cleaned)
        return value if isinstance(value, (dict, list)) else {}
    except json.JSONDecodeError:
        match = re.search(r"(?:\{[\s\S]*\}|\[[\s\S]*\])", cleaned)
        if not match:
            return {}
        try:
            value = json.loads(match.group(0))
            return value if isinstance(value, (dict, list)) else {}
        except json.JSONDecodeError:
            return {}


def _seconds(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return max(0.0, float(value))
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return max(0.0, float(text))
    except ValueError:
        pass
    parts = text.split(":")
    try:
        if len(parts) == 2:
            return max(0.0, float(parts[0]) * 60 + float(parts[1]))
        if len(parts) == 3:
            return max(
                0.0,
                float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2]),
            )
    except ValueError:
        return None
    return None


def _parse_model_segments(text: str, offset_seconds: float = 0.0) -> list[dict]:
    data = _json_value(text)
    raw_segments = (
        data
        if isinstance(data, list)
        else data.get("segments") or data.get("captions") or []
    )
    if not isinstance(raw_segments, list):
        return []
    segments = []
    for index, item in enumerate(raw_segments):
        if not isinstance(item, dict):
            continue
        caption = re.sub(r"\s+", " ", str(item.get("text") or "")).strip()
        if not caption:
            continue
        relative = _seconds(
            item.get("start_seconds", item.get("start", item.get("timestamp")))
        )
        if relative is None:
            relative = float(index)
        segments.append({"seconds": offset_seconds + relative, "text": caption})
    return segments


def _caption_key(text: str) -> str:
    return re.sub(r"[\W_]+", "", str(text or "").lower(), flags=re.UNICODE)


def _merge_segments(segments: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for item in sorted(segments, key=lambda value: float(value.get("seconds") or 0)):
        text = str(item.get("text") or "").strip()
        seconds = float(item.get("seconds") or 0)
        key = _caption_key(text)
        if not key:
            continue
        duplicate = False
        for previous in reversed(merged[-10:]):
            gap = seconds - float(previous["seconds"])
            if gap > 8:
                break
            previous_key = _caption_key(previous["text"])
            current_chunk = item.get("chunk_index")
            previous_chunk = previous.get("chunk_index")
            crosses_chunk_boundary = (
                current_chunk is None
                or previous_chunk is None
                or current_chunk != previous_chunk
            )
            if crosses_chunk_boundary and key == previous_key:
                duplicate = True
                break
        if not duplicate:
            merged.append({
                "seconds": seconds,
                "text": text,
                "chunk_index": item.get("chunk_index"),
            })
    return merged


def _format_segments(segments: list[dict]) -> str:
    lines = []
    for item in segments:
        total = max(0, int(float(item["seconds"])))
        lines.append(f"[{total // 60:02d}:{total % 60:02d}] {item['text']}")
    return "\n".join(lines)


def _request_openrouter_chunk(
    client: httpx.Client, chunk_path: Path, model: str
) -> tuple[list[dict], str]:
    encoded = base64.b64encode(chunk_path.read_bytes()).decode("ascii")
    payload = {
        "model": model,
        "temperature": 0,
        "max_tokens": 8000,
        "response_format": {"type": "json_object"},
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": _PROMPT},
                {
                    "type": "video_url",
                    "video_url": {"url": f"data:video/mp4;base64,{encoded}"},
                },
            ],
        }],
    }
    try:
        response = client.post("/chat/completions", json=payload)
    except httpx.HTTPError:
        return [], "OpenRouter 网络请求失败"
    if response.status_code >= 400:
        return [], f"OpenRouter 请求失败（HTTP {response.status_code}）"
    try:
        text = _message_text(response.json())
    except (ValueError, TypeError):
        return [], "OpenRouter 返回了无法解析的响应"
    segments = _parse_model_segments(text)
    if not segments:
        return [], "视频模型未返回可用的画面文字"
    return segments, ""


def _gemini_message_text(payload: dict) -> str:
    try:
        parts = payload["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError, TypeError):
        return ""
    return "\n".join(
        str(part.get("text") or "")
        for part in parts
        if isinstance(part, dict) and part.get("text")
    )


def _request_moxus_chunk(
    client: httpx.Client,
    chunk_path: Path,
    model: str,
    api_key: str,
) -> tuple[list[dict], str]:
    encoded = base64.b64encode(chunk_path.read_bytes()).decode("ascii")
    payload = {
        "contents": [{
            "role": "user",
            "parts": [
                {
                    "inline_data": {
                        "mime_type": "video/mp4",
                        "data": encoded,
                    },
                },
                {"text": _PROMPT},
            ],
        }],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "maxOutputTokens": 8192,
        },
    }
    response = None
    for attempt in range(max(1, VIDEO_MODEL_REQUEST_RETRIES)):
        try:
            response = client.post(
                f"/v1beta/models/{quote(model, safe='')}:generateContent",
                params={"key": api_key},
                json=payload,
            )
        except httpx.HTTPError:
            if attempt + 1 >= max(1, VIDEO_MODEL_REQUEST_RETRIES):
                return [], "Moxus 网络请求失败"
            time.sleep(2 ** attempt)
            continue
        if response.status_code not in {429, 500, 502, 503, 504, 529}:
            break
        if attempt + 1 < max(1, VIDEO_MODEL_REQUEST_RETRIES):
            time.sleep(2 ** attempt)
    if response is None:
        return [], "Moxus 网络请求失败"
    if response.status_code >= 400:
        message = ""
        try:
            message = str((response.json().get("error") or {}).get("message") or "")
        except (ValueError, TypeError):
            pass
        safe_message = redact_sensitive_text(message, max_length=160)
        suffix = f"：{safe_message}" if safe_message else ""
        return [], f"Moxus 请求失败（HTTP {response.status_code}）{suffix}"
    try:
        text = _gemini_message_text(response.json())
    except (ValueError, TypeError):
        return [], "Moxus 返回了无法解析的响应"
    segments = _parse_model_segments(text)
    if not segments:
        return [], "视频模型未返回可用的画面文字"
    return segments, ""


def transcribe_video_with_model(video_path: str, output_dir: str) -> dict:
    """Extract every caption change from overlapping video chunks."""
    provider = _provider_config()
    if not provider["api_key"]:
        key_name = "MOXUS_API_KEY" if provider["provider"] == "moxus" else "OPENROUTER_API_KEY"
        return _base_result("unavailable", provider, f"未配置 {key_name}")
    source = Path(video_path)
    if not source.exists():
        return _base_result("unavailable", provider, "临时视频文件不存在")
    duration = _probe_duration(str(source))
    starts = _build_chunk_starts(duration)
    if not starts:
        return _base_result("unavailable", provider, "无法读取视频时长")

    result = _base_result("unavailable", provider)
    result["chunks_total"] = len(starts)
    all_segments: list[dict] = []
    errors: list[str] = []
    chunk_dir = Path(output_dir)
    headers = {"Content-Type": "application/json"}
    if provider["provider"] == "openrouter":
        headers.update({
            "Authorization": f"Bearer {provider['api_key']}",
            "HTTP-Referer": "http://127.0.0.1:5000",
            "X-Title": "Evidence-led Content Intelligence",
        })
    timeout = httpx.Timeout(360.0, connect=30.0)
    with httpx.Client(
        base_url=provider["base_url"].rstrip("/"),
        headers=headers,
        timeout=timeout,
        follow_redirects=True,
    ) as client:
        for index, start in enumerate(starts):
            length = min(float(VIDEO_MODEL_CHUNK_SECONDS), max(0.0, duration - start))
            chunk_path = chunk_dir / f"chunk_{index:03d}.mp4"
            if length <= 0 or not _encode_chunk(str(source), chunk_path, start, length):
                errors.append(f"第 {index + 1} 段压缩失败")
                continue
            try:
                if provider["provider"] == "moxus":
                    segments, error = _request_moxus_chunk(
                        client, chunk_path, provider["model"], provider["api_key"]
                    )
                else:
                    segments, error = _request_openrouter_chunk(
                        client, chunk_path, provider["model"]
                    )
            finally:
                try:
                    if chunk_path.resolve().parent == chunk_dir.resolve():
                        chunk_path.unlink(missing_ok=True)
                except OSError:
                    pass
            if error:
                errors.append(f"第 {index + 1} 段：{error}")
                continue
            result["chunks_succeeded"] += 1
            all_segments.extend(
                {
                    "seconds": start + item["seconds"],
                    "text": item["text"],
                    "chunk_index": index,
                }
                for item in segments
            )

    merged = _merge_segments(all_segments)
    result["text"] = _format_segments(merged)
    if result["text"]:
        result["status"] = (
            "ok" if result["chunks_succeeded"] == result["chunks_total"] else "partial"
        )
    result["message"] = "；".join(errors[:3])
    return result
