"""P0 business analysis for collected short-video content and comments.

The model is asked for structured summaries only. Comment quotations are never
accepted from the model: it returns comment IDs and this module hydrates the
original, locally collected comment text afterwards.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

from openai import OpenAI

from config import LLM_API_KEY, LLM_BASE_URL, MODEL_LLM


VIDEO_FIELDS = (
    ("main_topic", "这条主要讲什么"),
    ("target_audience", "针对什么人 / 场景"),
    ("user_need", "用户主要问题或需求"),
    ("content_structure", "内容怎么展开"),
    ("solution", "给了什么解决办法"),
    ("references", "值得参考什么"),
    ("extensions", "还能延伸做什么内容"),
)

COMMENT_FIELDS = (
    ("main_questions", "大家主要在问什么"),
    ("high_frequency_needs", "高频需求"),
    ("worries", "最担心什么"),
    ("unclear_points", "博主没讲清什么"),
)


def _clean_text(value: Any, limit: int = 0) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit] if limit else text


def _json_object(raw: str) -> dict:
    """Parse a JSON object from plain or fenced model output."""
    text = str(raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("AI 返回内容不是有效 JSON")
    parsed = json.loads(text[start:end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("AI 返回的 JSON 顶层必须是对象")
    return parsed


def _chat_json(system_prompt: str, user_prompt: str, max_tokens: int = 1800) -> dict:
    if not LLM_API_KEY:
        raise RuntimeError("未配置文本分析模型 API Key")

    client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
    request_args = {
        "model": MODEL_LLM,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.2,
    }
    if MODEL_LLM.startswith("deepseek-v4"):
        request_args["extra_body"] = {"thinking": {"type": "disabled"}}
    response = client.chat.completions.create(**request_args)
    return _json_object(response.choices[0].message.content or "")


def _video_source(content: dict) -> tuple[str, list[str], list[dict]]:
    engagement = content.get("engagement") or {}
    sections: list[str] = []
    source_labels: list[str] = []
    source_inventory: list[dict] = []

    def add(label: str, value: Any, limit: int) -> None:
        cleaned = _clean_text(value, limit)
        if cleaned:
            sections.append(f"【{label}】\n{cleaned}")
            source_labels.append(label)
            source_inventory.append({
                "label": label,
                "characters": len(cleaned),
                "excerpt": cleaned[:600],
            })

    add("封面标题", content.get("cover_title"), 300)
    add("文字标题", content.get("post_title") or content.get("title"), 500)
    add("作品描述", content.get("post_description", content.get("description")), 2500)
    if not content.get("images"):
        add("页面正文", content.get("page_text"), 3500)
    video_text_label = (
        "视频模型逐段识别"
        if (content.get("video_text_meta") or {}).get("method") in {
            "moxus_video", "openrouter_video"
        }
        else "画面 OCR"
    )
    add(video_text_label, content.get("video_text"), 5000)
    add("语音转写", content.get("audio_text"), 6000)

    image_ocr: list[str] = []
    for item in (content.get("images") or [])[:20]:
        text = _clean_text(item.get("text"), 1200)
        if text:
            image_ocr.append(f"图片 {item.get('index') or len(image_ocr) + 1}：{text}")
        if sum(len(value) for value in image_ocr) >= 8000:
            break
    add("图片 OCR", "\n".join(image_ocr), 8000)

    stats = "；".join(
        f"{label}{engagement.get(key) or '未获取'}"
        for label, key in (("点赞", "likes"), ("收藏", "collects"), ("评论", "comments"))
    )
    sections.append(f"【公开互动数据】\n{stats}")
    source_labels.append("公开互动数据")
    source_inventory.append({
        "label": "公开互动数据",
        "characters": len(stats),
        "excerpt": stats,
    })
    return "\n\n".join(sections), source_labels, source_inventory


def _valid_source_labels(value: Any, allowed: list[str]) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    return [label for label in dict.fromkeys(map(str, value)) if label in allowed]


def _video_analysis(content: dict) -> dict:
    source, source_labels, source_inventory = _video_source(content)
    meaningful = any(
        _clean_text(content.get(key))
        for key in ("cover_title", "post_title", "title", "post_description",
                    "description", "page_text", "video_text", "audio_text")
    ) or any(_clean_text(item.get("text")) for item in (content.get("images") or []))
    if not meaningful:
        return {
            "status": "insufficient_source",
            "message": "没有可用于分析的视频文字或内容正文。",
            "items": {},
            "source_labels": source_labels,
            "_audit": {"source_inventory": source_inventory, "items": {}},
        }

    system = """你是短视频业务研究助理。只根据提供的公开数据和文字整理事实，不补写没有证据的人物身份、动机、心理标签或效果承诺。输出必须是一个 JSON 对象，不要 Markdown，不要解释。每项同时给出客户可读结论和技术人员可核对的简短依据；依据只说明使用了什么证据以及结论如何受证据约束，不展示逐步思维链。"""
    fields = "\n".join(f"{key}：{label}" for key, label in VIDEO_FIELDS)
    user = f"""请分析下面这条短视频或图文内容。严格输出以下 7 个字段，字段不能增删：
{fields}

每个字段的值必须是：
{{"summary": "给客户看的 1–3 句结论", "basis": "给技术人员看的可核对依据，说明关键证据与限制", "source_labels": ["实际使用的数据源名称"]}}

规则：
1. summary 区分内容明确表达的事实和基于内容的保守归纳，不做复杂心理画像。
2. basis 只写简短的证据说明，不输出隐藏思维链、逐步推演或未经证实的猜测。
3. source_labels 只能从这些名称选择：{json.dumps(source_labels, ensure_ascii=False)}。
4. solution 没有明确办法时写“内容未给出明确解决办法”。

{source}"""
    raw = _chat_json(system, user, max_tokens=2600)
    items: dict[str, dict] = {}
    audit_items: dict[str, dict] = {}
    for key, label in VIDEO_FIELDS:
        value = raw.get(key)
        if isinstance(value, dict):
            summary = _clean_text(value.get("summary"), 1200)
            basis = _clean_text(value.get("basis"), 1200)
            used_sources = _valid_source_labels(value.get("source_labels"), source_labels)
        else:  # Backward-compatible with providers or tests using the old shape.
            summary = _clean_text(value, 1200)
            basis = ""
            used_sources = []
        items[key] = {"label": label, "summary": summary}
        audit_items[key] = {
            "label": label,
            "output": summary,
            "basis": basis or "模型未返回单独依据；请按数据源清单与原始内容复核该结论。",
            "basis_origin": "model_supplied" if basis else "fallback",
            "source_labels": used_sources or source_labels,
        }
    if not all(item["summary"] for item in items.values()):
        missing = [item["label"] for item in items.values() if not item["summary"]]
        raise ValueError("AI 视频分析缺少固定栏目：" + "、".join(missing))
    return {
        "status": "ok",
        "message": "",
        "items": items,
        "source_labels": source_labels,
        "_audit": {"source_inventory": source_inventory, "items": audit_items},
    }


def _comment_evidence(comment: dict) -> dict:
    return {
        "id": str(comment.get("id") or ""),
        "author": _clean_text(comment.get("author"), 80) or "匿名",
        "text": _clean_text(comment.get("text"), 1000),
        "like_count": int(comment.get("like_count") or 0),
        "type": "reply" if comment.get("type") == "reply" else "comment",
    }


def _valid_comment_ids(value: Any, comment_map: dict[str, dict], limit: int = 3) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        comment_id = str(item or "").strip()
        if comment_id in comment_map and comment_id not in result:
            result.append(comment_id)
        if len(result) >= limit:
            break
    return result


def _hydrate_ids(ids: list[str], comment_map: dict[str, dict]) -> list[dict]:
    return [_comment_evidence(comment_map[comment_id]) for comment_id in ids if comment_id in comment_map]


def _comment_analysis(content: dict) -> dict:
    comments = [item for item in (content.get("comments") or []) if _clean_text(item.get("text"))]
    if not comments:
        return {
            "status": "empty",
            "message": "暂无评论，未生成评论需求分析。",
            "sample_size": 0,
            "items": {},
            "_audit": {"items": {}},
        }

    comment_map = {str(item.get("id") or index + 1): item for index, item in enumerate(comments)}
    rows = []
    for comment_id, item in comment_map.items():
        rows.append(
            json.dumps(
                {
                    "comment_id": comment_id,
                    "type": item.get("type") or "comment",
                    "author": item.get("author") or "匿名",
                    "likes": int(item.get("like_count") or 0),
                    "text": _clean_text(item.get("text"), 1000),
                },
                ensure_ascii=False,
            )
        )

    system = """你是短视频评论区需求研究助理。只根据给出的评论原话整理，不推断评论者身份、收入、人格或心理类型。重要结论必须引用提供的 comment_id，禁止改写或伪造评论原话。输出必须是一个 JSON 对象，不要 Markdown。每项 basis 只提供技术人员可核对的简短归纳依据，不展示逐步思维链。"""
    user = f"""请整理下面评论区里的用户需求。输出 JSON，结构必须严格如下：
{{
  "main_questions": {{"summary": "大家主要在问什么", "basis": "关键证据和样本限制", "comment_ids": ["代表性 comment_id"]}},
  "high_frequency_needs": {{"summary": "高频需求", "basis": "关键证据和样本限制", "comment_ids": ["代表性 comment_id"]}},
  "worries": {{"summary": "最担心什么", "basis": "关键证据和样本限制", "comment_ids": ["代表性 comment_id"]}},
  "unclear_points": {{"summary": "博主没讲清什么", "basis": "关键证据和样本限制", "comment_ids": ["代表性 comment_id"]}},
  "key_comments": [{{"comment_id": "值得重点看的 comment_id", "reason": "为什么值得看"}}],
  "topic_extensions": [{{"idea": "可延伸选题", "comment_ids": ["需求依据 comment_id"]}}]
}}

规则：
1. 每个 summary 1–3 句；评论证据不足时明确写“现有样本未形成明确结论”。
2. comment_ids 只能从下方数据复制，单项最多 3 个。
3. key_comments 最多 5 条；topic_extensions 最多 5 个。
4. “高频”只按当前样本判断，不把少量评论说成全体用户。
5. basis 只解释结论引用了哪些评论信号以及样本限制，不输出隐藏思维链。

评论样本（共 {len(comments)} 条）：
{chr(10).join(rows)}"""
    raw = _chat_json(system, user, max_tokens=2200)

    items: dict[str, Any] = {}
    audit_items: dict[str, Any] = {}
    for key, label in COMMENT_FIELDS:
        value = raw.get(key) if isinstance(raw.get(key), dict) else {}
        comment_ids = _valid_comment_ids(value.get("comment_ids"), comment_map)
        summary = _clean_text(value.get("summary"), 1200)
        basis = _clean_text(value.get("basis"), 1200)
        if not comment_ids:
            # A concrete conclusion without a source ID would violate the
            # product's evidence-first contract, so downgrade it explicitly.
            summary = "现有样本未形成明确结论。"
        items[key] = {
            "label": label,
            "summary": summary or "现有样本未形成明确结论。",
            "evidence_comments": _hydrate_ids(comment_ids, comment_map),
        }
        audit_items[key] = {
            "label": label,
            "output": items[key]["summary"],
            "basis": (
                basis
                if comment_ids
                else "模型未提供可验证的评论 ID，因此该项已降级为样本不足。"
            ),
            "basis_origin": "model_supplied" if basis and comment_ids else "fallback",
            "evidence_comments": items[key]["evidence_comments"],
        }

    key_comments = []
    for value in raw.get("key_comments") or []:
        if not isinstance(value, dict):
            continue
        comment_ids = _valid_comment_ids(value.get("comment_id"), comment_map, 1)
        if not comment_ids:
            continue
        key_comments.append({
            "comment": _comment_evidence(comment_map[comment_ids[0]]),
            "reason": _clean_text(value.get("reason"), 500) or "这条评论提供了较明确的需求或异议信号。",
        })
        if len(key_comments) >= 5:
            break

    topic_extensions = []
    for value in raw.get("topic_extensions") or []:
        if not isinstance(value, dict):
            continue
        idea = _clean_text(value.get("idea"), 500)
        if not idea:
            continue
        comment_ids = _valid_comment_ids(value.get("comment_ids"), comment_map)
        if not comment_ids:
            continue
        topic_extensions.append({
            "idea": idea,
            "evidence_comments": _hydrate_ids(comment_ids, comment_map),
        })
        if len(topic_extensions) >= 5:
            break

    items["key_comments"] = {"label": "哪些评论值得重点看", "entries": key_comments}
    items["topic_extensions"] = {"label": "可以延伸什么选题", "entries": topic_extensions}
    return {
        "status": "ok",
        "message": "",
        "sample_size": len(comments),
        "items": items,
        "_audit": {
            "items": audit_items,
            "key_comments": key_comments,
            "topic_extensions": topic_extensions,
        },
    }


def analyze_content_with_audit(content: dict) -> tuple[dict, dict]:
    """Return the customer-facing analysis and a separate technical audit artifact."""
    generated_at = datetime.now(timezone.utc).isoformat()

    try:
        video = _video_analysis(content)
    except Exception as exc:  # API/provider problems should not discard raw data.
        video = {"status": "unavailable", "message": str(exc), "items": {}, "source_labels": []}

    try:
        comments = _comment_analysis(content)
    except Exception as exc:
        comments = {
            "status": "unavailable",
            "message": str(exc),
            "sample_size": len(content.get("comments") or []),
            "items": {},
        }

    video_audit = video.pop("_audit", {"source_inventory": [], "items": {}})
    comments_audit = comments.pop("_audit", {"items": {}})
    successful = sum(part.get("status") == "ok" for part in (video, comments))
    status = "ok" if successful == 2 else "partial" if successful else "unavailable"
    analysis = {
        "schema_version": 1,
        "status": status,
        "model": MODEL_LLM,
        "generated_at": generated_at,
        "notice": "AI 仅基于页面公开数据与已采集原话做辅助整理，请结合原始证据判断。",
        "video": video,
        "comments": comments,
    }
    audit = {
        "schema_version": 1,
        "artifact_type": "ai_analysis_technical_audit",
        "audience": "technical",
        "task_id": content.get("task_id") or "",
        "source_url": content.get("source_url") or "",
        "platform": content.get("platform") or "",
        "media_type": content.get("media_type") or "",
        "model": MODEL_LLM,
        "generated_at": generated_at,
        "analysis_status": status,
        "disclaimer": (
            "本文件保存可核对的结论依据、证据引用与限制，不包含模型隐藏思维链。"
            "客户页面仅使用 content.json 中的 ai_analysis。"
        ),
        "video": {
            "status": video.get("status"),
            "message": video.get("message") or "",
            "source_inventory": video_audit.get("source_inventory") or [],
            "items": video_audit.get("items") or {},
        },
        "comments": {
            "status": comments.get("status"),
            "message": comments.get("message") or "",
            "sample_size": comments.get("sample_size") or 0,
            "items": comments_audit.get("items") or {},
            "key_comments": comments_audit.get("key_comments") or [],
            "topic_extensions": comments_audit.get("topic_extensions") or [],
        },
    }
    return analysis, audit


def analyze_content(content: dict) -> dict:
    """Return only the customer-facing analysis for backward compatibility."""
    return analyze_content_with_audit(content)[0]


def build_technical_audit_markdown(audit: dict) -> str:
    """Render the compact human-readable companion to the technical audit JSON."""
    lines = [
        "# AI 分析技术审计",
        "",
        f"- 任务 ID：{audit.get('task_id') or '—'}",
        f"- 模型：{audit.get('model') or '—'}",
        f"- 生成时间：{audit.get('generated_at') or '—'}",
        f"- 总体状态：{audit.get('analysis_status') or '—'}",
        "",
        f"> {audit.get('disclaimer') or ''}",
        "",
        "## 视频 / 内容分析",
    ]

    video = audit.get("video") or {}
    if video.get("message"):
        lines.extend(["", f"状态说明：{video['message']}"])
    for item in (video.get("items") or {}).values():
        sources = "、".join(item.get("source_labels") or []) or "未标注"
        lines.extend([
            "",
            f"### {item.get('label') or '未命名栏目'}",
            "",
            f"- 客户结论：{item.get('output') or '—'}",
            f"- 可核对依据：{item.get('basis') or '—'}",
            f"- 使用数据源：{sources}",
            f"- 依据来源：{item.get('basis_origin') or '—'}",
        ])

    comments = audit.get("comments") or {}
    lines.extend(["", "## 评论需求分析", "", f"- 评论样本数：{comments.get('sample_size') or 0}"])
    if comments.get("message"):
        lines.append(f"- 状态说明：{comments['message']}")
    for item in (comments.get("items") or {}).values():
        evidence = item.get("evidence_comments") or []
        evidence_text = "；".join(
            f"{comment.get('id') or '—'}｜{comment.get('author') or '匿名'}：{comment.get('text') or ''}"
            for comment in evidence
        ) or "无有效评论证据"
        lines.extend([
            "",
            f"### {item.get('label') or '未命名栏目'}",
            "",
            f"- 客户结论：{item.get('output') or '—'}",
            f"- 可核对依据：{item.get('basis') or '—'}",
            f"- 评论证据：{evidence_text}",
            f"- 依据来源：{item.get('basis_origin') or '—'}",
        ])
    return "\n".join(lines).rstrip() + "\n"
