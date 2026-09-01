"""Turn archived post images into bounded, attributable visual evidence.

The model never decides the final research dimensions here. It only records
observable visual facts for a later evidence-led analysis. Image bytes and raw
provider responses are kept in memory and are never logged or persisted.
"""
from __future__ import annotations

import base64
import json
import re
from io import BytesIO
from pathlib import Path
from typing import Any

from openai import OpenAI
from PIL import Image, ImageOps

from config import LLM_API_KEY, LLM_BASE_URL, MODEL_LLM


VISUAL_EVIDENCE_VERSION = "collector-visual-evidence/1.0"
_BATCH_SIZE = 8
_MAX_IMAGES = 20
_MAX_SIDE = 1280

_PROMPT = """你是内容研究系统的视觉证据记录员。只记录画面中能够直接观察到的事实，禁止推断人物身份、收入、性格、心理或传播效果。
输入包含按顺序排列的多张图片，每张图片前都有 image_index。请逐张返回证据，不得合并、遗漏或虚构索引。
重点记录：主体与场景、构图、色彩、光线、文字层级与版式、镜头/视角，以及多图之间可直接观察到的视觉节奏。
description 必须是一段简洁客观描述；其它字段没有足够证据时填 null。confidence 表示对视觉观察准确性的信心。
只返回 JSON 对象，不要 Markdown：
{"items":[{"image_index":1,"description":"客观画面描述","composition":"构图","subjects":"主体","setting":"场景","palette":"色彩","lighting":"光线","typography":"文字与版式","camera":"景别或视角","visual_rhythm":"与相邻图片的节奏关系","confidence":0.9}]}"""


def _json_object(text: str) -> dict:
    cleaned = str(text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", cleaned)
        if not match:
            return {}
        try:
            value = json.loads(match.group(0))
        except json.JSONDecodeError:
            return {}
    return value if isinstance(value, dict) else {}


def _clean(value: Any, limit: int = 1200) -> str | None:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit] or None


def _confidence(value: Any) -> float:
    try:
        return round(max(0.0, min(1.0, float(value))), 3)
    except (TypeError, ValueError):
        return 0.5


def _thumbnail_data_url(path: str) -> str:
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((_MAX_SIDE, _MAX_SIDE), Image.Resampling.LANCZOS)
        output = BytesIO()
        image.save(output, "JPEG", quality=82, optimize=True)
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def _normalized_item(raw: dict, image: dict, fallback_index: int) -> dict:
    index = int(image.get("index") or fallback_index)
    fields = {
        key: _clean(raw.get(key))
        for key in (
            "description", "composition", "subjects", "setting", "palette",
            "lighting", "typography", "camera", "visual_rhythm",
        )
    }
    if not fields["description"]:
        fields["description"] = next((value for value in fields.values() if value), None)
    return {
        "source_kind": "image_vision",
        "asset_kind": "image",
        "image_index": index,
        "filename": Path(str(image.get("path") or "")).name,
        "source_url": _clean(image.get("source_url"), 2000),
        **fields,
        "confidence": _confidence(raw.get("confidence")),
    }


def analyze_images_visual_evidence(images: list[dict]) -> dict:
    """Analyze downloaded post images in small batches and return safe evidence."""
    candidates = [item for item in (images or []) if Path(str(item.get("path") or "")).is_file()][:_MAX_IMAGES]
    meta = {
        "status": "unavailable",
        "provider": "collector_llm",
        "model": MODEL_LLM,
        "schema_version": VISUAL_EVIDENCE_VERSION,
        "images_total": len(candidates),
        "images_succeeded": 0,
        "message": "",
    }
    if not candidates:
        meta.update(status="empty", message="没有可分析的图片")
        return {"items": [], "meta": meta}
    if not LLM_API_KEY:
        meta["message"] = "未配置视觉分析模型 API Key"
        return {"items": [], "meta": meta}

    client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL, timeout=180.0)
    evidence: list[dict] = []
    errors: list[str] = []
    for start in range(0, len(candidates), _BATCH_SIZE):
        batch = candidates[start:start + _BATCH_SIZE]
        content: list[dict] = [{"type": "text", "text": _PROMPT}]
        available: dict[int, dict] = {}
        for offset, image in enumerate(batch, start=start + 1):
            index = int(image.get("index") or offset)
            try:
                data_url = _thumbnail_data_url(str(image.get("path") or ""))
            except (OSError, ValueError):
                errors.append(f"第 {index} 张图片无法读取")
                continue
            available[index] = image
            content.extend([
                {"type": "text", "text": f"image_index={index}"},
                {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
            ])
        if not available:
            continue
        try:
            response = client.chat.completions.create(
                model=MODEL_LLM,
                temperature=0,
                max_tokens=min(6000, 700 * len(available) + 400),
                messages=[{"role": "user", "content": content}],
            )
            parsed = _json_object(response.choices[0].message.content or "")
        except Exception as exc:  # provider failures must not discard the raw collection
            errors.append(f"视觉模型请求失败（{exc.__class__.__name__}）")
            continue
        returned = parsed.get("items") if isinstance(parsed.get("items"), list) else []
        seen: set[int] = set()
        for raw in returned:
            if not isinstance(raw, dict):
                continue
            try:
                index = int(raw.get("image_index"))
            except (TypeError, ValueError):
                continue
            if index not in available or index in seen:
                continue
            item = _normalized_item(raw, available[index], index)
            if not item["description"]:
                continue
            seen.add(index)
            evidence.append(item)
        meta["images_succeeded"] += len(seen)

    if meta["images_succeeded"]:
        meta["status"] = "ok" if meta["images_succeeded"] == meta["images_total"] else "partial"
    meta["message"] = "；".join(errors[:3])
    return {"items": evidence, "meta": meta}
