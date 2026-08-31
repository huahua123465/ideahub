"""Flask Web UI: extract text and metadata from social-media posts."""
import base64
import hashlib
import json
import re
import shutil
import threading
import asyncio
import httpx
import uuid
import time
from datetime import datetime
from io import BytesIO
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory
from PIL import Image

from config import (
    OUTPUT_DIR,
    IDEAHUB_API_KEY,
    IDEAHUB_INGEST_URL,
    IDEAHUB_SAMPLE_INGEST_URL,
    IDEAHUB_DOC_URL,
    COLLECTOR_INTERNAL_TOKEN,
    COLLECTOR_MAX_CONCURRENT,
    COLLECTOR_MAX_QUEUE,
    COLLECTOR_QR_TTL_SEC,
)
from db import TaskDB
from security import (
    UnsafeUrl,
    public_error_message,
    redact_sensitive_text,
    valid_internal_token,
    validate_public_url,
)
from utils import (url_to_id, detect_platform, resolve_share_url,
                   canonical_content_key)
from media import (download_video, extract_video_text,
                   download_post_images, extract_images_text, extract_hot_comments,
                   extract_video_metadata, has_saved_xhs_login, invalidate_xhs_login,
                   clear_xhs_login_session,
                   login_xiaohongshu, read_xhs_login_profile,
                   persist_xhs_login_session, read_xhs_login_label,
                   save_xhs_login_label,
                   sync_saved_xhs_account, friendly_xhs_login_error,
                   extract_cover_title_from_path,
                   download_video_cover, reconcile_cover_title,
                   transcribe_video_with_model, url_declares_video)
from media import XHS_QR_FILE
from media.content_extractor import (extract_page, clean_post_title,
                                     strip_topics_from_description)
from media.profile_extractor import (
    account_from_downloader,
    empty_account,
    hydrate_account,
    merge_accounts,
)
from generators.business_analyzer import (
    analyze_content_with_audit,
    build_technical_audit_markdown,
)

app = Flask(__name__)
db = TaskDB()
db.recover_interrupted_tasks()
_running = {}
_task_state_lock = threading.Lock()
_content_write_lock = threading.Lock()
MAX_CONCURRENT_TASKS = COLLECTOR_MAX_CONCURRENT
_pipeline_slots = threading.BoundedSemaphore(MAX_CONCURRENT_TASKS)
_login_state_lock = threading.RLock()
_login_generation = 0
_login_state = {
    "status": "saved" if has_saved_xhs_login() else "idle",
    "message": "",
    "qr_available": False,
}
XHS_QR_FILE.unlink(missing_ok=True)


def _login_generation_is_current(generation: int) -> bool:
    with _login_state_lock:
        return generation == _login_generation


def _update_login_generation(generation: int, status: str, message: str, **state) -> bool:
    with _login_state_lock:
        if generation != _login_generation:
            return False
        _login_state.update(
            status=status,
            message=redact_sensitive_text(message),
            qr_available=bool(state.get("qr_available")),
            expires_at=state.get("expires_at"),
        )
        return True


def _publish_login_qr(generation: int, temp_path: Path) -> bool:
    with _login_state_lock:
        if generation != _login_generation:
            return False
        temp_path.replace(XHS_QR_FILE)
        return True


def _commit_login_session(
    generation: int, cookies: list[dict], storage_state: dict, profile: dict, *,
    clear_label: bool = False,
) -> bool:
    with _login_state_lock:
        if generation != _login_generation:
            return False
        persist_xhs_login_session(
            cookies, storage_state, profile, clear_label=clear_label,
        )
        return True


def _cleanup_login_qr(generation: int) -> None:
    with _login_state_lock:
        if generation == _login_generation:
            XHS_QR_FILE.unlink(missing_ok=True)


def _cancel_login_attempt(status: str, message: str) -> None:
    global _login_generation
    with _login_state_lock:
        _login_generation += 1
        XHS_QR_FILE.unlink(missing_ok=True)
        _login_state.update(
            status=status,
            message=redact_sensitive_text(message),
            qr_available=False,
            expires_at=None,
        )

IDEAHUB_CHANNELS = {
    "persona": "真人作品 → 对标账号",
    "matrix": "矩阵作品 → 对标账号",
    "persona,matrix": "真人作品、矩阵作品 → 对标账号",
}
IDEAHUB_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
IDEAHUB_MAX_COVER_IMAGE_BYTES = 3 * 1024 * 1024

COLLECTION_MODE = "analyze"
COLLECTION_MODE_LABEL = "采集分析"
STORAGE_POLICY = "source_linked"
CONTENT_SCHEMA_VERSION = 17
AI_ANALYSIS_TEXT_LIMIT = 6000
AI_VIDEO_EDIT_KEYS = (
    "main_topic", "target_audience", "user_need", "content_structure",
    "solution", "references", "extensions",
)
AI_COMMENT_EDIT_KEYS = (
    "main_questions", "high_frequency_needs", "worries", "unclear_points",
)


@app.before_request
def _require_internal_token():
    """Refuse every route except health unless IdeaHub proves its identity."""
    if request.path == "/health":
        return None
    if app.config.get("TESTING") and app.config.get("COLLECTOR_AUTH_BYPASS_TESTS", True):
        return None
    supplied = request.headers.get("X-Collector-Token", "")
    if len((COLLECTOR_INTERNAL_TOKEN or "").encode("utf-8")) < 32:
        return jsonify({"error": "Collector 内部令牌未配置"}), 503
    if not valid_internal_token(COLLECTOR_INTERNAL_TOKEN, supplied):
        return jsonify({"error": "未授权访问"}), 401
    return None


@app.after_request
def _secure_sensitive_responses(response):
    if request.path.startswith("/api/login/xiaohongshu"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
        response.headers["Pragma"] = "no-cache"
        response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.route("/health")
def health():
    configured = len((COLLECTOR_INTERNAL_TOKEN or "").encode("utf-8")) >= 32
    return jsonify({
        "ok": configured,
        "status": "ok" if configured else "misconfigured",
        "max_concurrent": MAX_CONCURRENT_TASKS,
        "max_queue": COLLECTOR_MAX_QUEUE,
    }), 200 if configured else 503


def _account_collection_status(account):
    labels = {
        "following_count": "关注量",
        "follower_count": "粉丝量",
        "likes_and_collections_count": "获赞与收藏量",
    }
    missing = [label for field, label in labels.items() if not account.get(field)]
    if not missing:
        return {"status": "ok", "missing_fields": [], "message": "账号数据已同步"}
    status = "partial" if len(missing) < len(labels) else "unavailable"
    return {
        "status": status,
        "missing_fields": missing,
        "message": f"平台暂未返回：{'、'.join(missing)}",
    }


def _is_local_request():
    return (request.remote_addr or "") in {"127.0.0.1", "::1"}


def _resolve_task_dir(vid):
    """Return a safe task directory for current and legacy task IDs."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", vid):
        return None
    output_root = OUTPUT_DIR.resolve()
    task_dir = (OUTPUT_DIR / vid).resolve()
    return task_dir if task_dir.parent == output_root else None


def _post_ideahub_analysis(payload, channel):
    url = f"{IDEAHUB_INGEST_URL.rstrip('?&')}?channel={channel}"
    headers = {
        "Authorization": f"Bearer {IDEAHUB_API_KEY}",
        "Content-Type": "application/json; charset=utf-8",
    }
    with httpx.Client(timeout=30.0, follow_redirects=False) as client:
        response = client.post(url, headers=headers, content=payload)

    try:
        body = response.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    if response.status_code < 200 or response.status_code >= 300 or not body.get("ok"):
        message = body.get("error") or body.get("message") or f"IdeaHub 返回 HTTP {response.status_code}"
        raise RuntimeError(message)
    return body


def _post_ideahub_sample(content: dict) -> dict:
    payload = json.dumps(content, ensure_ascii=False).encode("utf-8")
    if len(payload) > IDEAHUB_MAX_PAYLOAD_BYTES:
        raise RuntimeError("样本归档数据超过 8MB，请减少内嵌内容后重试")
    headers = {
        "Authorization": f"Bearer {IDEAHUB_API_KEY}",
        "Content-Type": "application/json; charset=utf-8",
    }
    with httpx.Client(timeout=90.0, follow_redirects=False) as client:
        response = client.post(
            IDEAHUB_SAMPLE_INGEST_URL, headers=headers, content=payload,
        )
    try:
        body = response.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
    if response.status_code < 200 or response.status_code >= 300 or not body.get("ok"):
        message = body.get("error") or body.get("message") or f"IdeaHub 返回 HTTP {response.status_code}"
        raise RuntimeError(message)
    return body


def _owner_task_id(url, owner_id):
    identity = f"{canonical_content_key(url)}\0{owner_id}".encode("utf-8")
    return hashlib.sha256(identity).hexdigest()[:12]


def _find_equivalent_task(url, owner_id):
    content_key = canonical_content_key(url)
    if not content_key:
        return None
    for task in db.list_tasks(200):
        if (str(task.get("owner_id") or "") == str(owner_id)
                and canonical_content_key(task.get("url") or "") == content_key):
            return task
    return None


def _run_async(coroutine):
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        return loop.run_until_complete(coroutine)
    finally:
        loop.close()


def _atomic_write_text(path, text):
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(text, encoding="utf-8")
    temp_path.replace(path)


def _validated_analysis_text(value, field_name):
    if not isinstance(value, str):
        raise ValueError(f"{field_name} 必须是文字")
    value = value.strip()
    if len(value) > AI_ANALYSIS_TEXT_LIMIT:
        raise ValueError(f"{field_name} 最多 {AI_ANALYSIS_TEXT_LIMIT} 个字符")
    return value


def _apply_ai_analysis_edits(content, payload):
    """Apply only user-editable AI conclusions; source evidence stays immutable."""
    if not isinstance(payload, dict):
        raise ValueError("编辑内容格式不正确")
    unknown_sections = set(payload) - {
        "video", "comments", "key_comments", "topic_extensions",
    }
    if unknown_sections:
        raise ValueError("包含不支持编辑的 AI 分析字段")

    analysis = content.get("ai_analysis")
    if not isinstance(analysis, dict):
        raise ValueError("当前任务没有可编辑的 AI 分析")
    edited_fields = 0

    video_edits = payload.get("video", {})
    if not isinstance(video_edits, dict):
        raise ValueError("视频分析格式不正确")
    unknown_video = set(video_edits) - set(AI_VIDEO_EDIT_KEYS)
    if unknown_video:
        raise ValueError("包含不支持编辑的视频分析字段")
    video_items = (analysis.get("video") or {}).get("items") or {}
    for key, value in video_edits.items():
        item = video_items.get(key)
        if not isinstance(item, dict):
            raise ValueError(f"视频分析字段 {key} 不存在")
        item["summary"] = _validated_analysis_text(value, item.get("label") or key)
        edited_fields += 1

    comment_edits = payload.get("comments", {})
    if not isinstance(comment_edits, dict):
        raise ValueError("评论分析格式不正确")
    unknown_comments = set(comment_edits) - set(AI_COMMENT_EDIT_KEYS)
    if unknown_comments:
        raise ValueError("包含不支持编辑的评论分析字段")
    comment_items = (analysis.get("comments") or {}).get("items") or {}
    for key, value in comment_edits.items():
        item = comment_items.get(key)
        if not isinstance(item, dict):
            raise ValueError(f"评论分析字段 {key} 不存在")
        item["summary"] = _validated_analysis_text(value, item.get("label") or key)
        edited_fields += 1

    list_fields = (
        ("key_comments", "reason", "重点评论"),
        ("topic_extensions", "idea", "延伸选题"),
    )
    for section_key, value_key, label in list_fields:
        if section_key not in payload:
            continue
        edits = payload[section_key]
        entries = (comment_items.get(section_key) or {}).get("entries") or []
        if not isinstance(edits, list) or len(edits) != len(entries):
            raise ValueError(f"{label}条目数量不一致，请刷新页面后重试")
        for index, value in enumerate(edits):
            entries[index][value_key] = _validated_analysis_text(
                value, f"{label} {index + 1}",
            )
            edited_fields += 1

    if not edited_fields:
        raise ValueError("没有收到可保存的 AI 分析文字")
    edited_at = datetime.now().astimezone().isoformat(timespec="seconds")
    analysis["manual_edit"] = {
        "edited_at": edited_at,
        "edited_fields": edited_fields,
    }
    return analysis


def _analyze_video_cover_path(cover_path, reference_title=""):
    if not cover_path:
        return {}
    result = extract_cover_title_from_path(cover_path) or {}
    if result:
        result = reconcile_cover_title(result, reference_title)
        result = {**result, "source": "platform_video_cover"}
    return result


def _select_platform_video_cover(thumbnail_url, page_images):
    """Prefer a platform cover over site chrome and low-quality previews."""
    candidates = []
    seen = set()
    sources = [(True, item) for item in (page_images or [])]
    sources.append((False, thumbnail_url))
    for from_page, url in sources:
        url = str(url or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        lower = url.casefold()
        score = 5 if from_page else 0
        if any(marker in lower for marker in ("xhscdn.com", "douyinpic.com", "douyincdn.com")):
            score += 40
        if "/spectrum/" in lower:
            score += 20
        if "!nd_dft_" in lower:
            score += 20
        elif "!nd_prv_" in lower:
            score += 4
        if any(marker in lower for marker in ("picasso-static", "avatar", "logo", "favicon", "emoji", "icon")):
            score -= 100
        candidates.append((score, url))
    return max(candidates, default=(0, ""), key=lambda item: item[0])[1]


def _collect_platform_video_cover(
    thumbnail_url, page_images, output_dir, referer, reference_title=""
):
    """Download once and use the same platform cover for OCR and IdeaHub."""
    cover_url = _select_platform_video_cover(thumbnail_url, page_images)
    cover_path = download_video_cover(cover_url, str(output_dir), referer)
    if not cover_path:
        return {}, {}

    cover_title = _analyze_video_cover_path(cover_path, reference_title)
    asset = {
        "cover_image_source": "platform_video_cover",
        "cover_image_url": cover_url,
    }
    data_url = _image_file_data_url(cover_path)
    if data_url:
        asset["cover_image_b64"] = data_url
    try:
        with Image.open(cover_path) as image:
            asset.update({
                "cover_image_width": image.width,
                "cover_image_height": image.height,
                "cover_image_size_bytes": Path(cover_path).stat().st_size,
            })
    except (OSError, ValueError):
        pass
    return cover_title, asset


def _image_file_data_url(image_path):
    """Encode a supported image without changing its bytes or declared type."""
    if not image_path:
        return ""
    try:
        payload = Path(image_path).read_bytes()
        if not payload or len(payload) > IDEAHUB_MAX_COVER_IMAGE_BYTES:
            return ""
        with Image.open(BytesIO(payload)) as image:
            mime_type = {
                "JPEG": "image/jpeg",
                "PNG": "image/png",
                "WEBP": "image/webp",
                "GIF": "image/gif",
                "AVIF": "image/avif",
            }.get((image.format or "").upper())
        if not mime_type:
            return ""
        encoded = base64.b64encode(payload).decode("ascii")
        return f"data:{mime_type};base64,{encoded}"
    except (OSError, ValueError):
        return ""


def _preserve_last_good_comments(comment_result, last_good):
    fresh_summary = comment_result.get("comment_summary") or {}
    fresh_comments = comment_result.get("comments") or []
    previous_comments = last_good.get("comments") or []
    if (
        previous_comments
        and not fresh_comments
        and fresh_summary.get("status") in {"unavailable", "partial", "login_required"}
    ):
        previous_summary = dict(last_good.get("comment_summary") or {})
        previous_summary.update({
            "preserved_previous": True,
            "last_refresh_status": fresh_summary.get("status"),
            "last_refresh_message": fresh_summary.get(
                "message", "本次未捕获到评论接口，已保留上次成功结果"
            ),
        })
        return {"comments": previous_comments, "comment_summary": previous_summary}
    return comment_result


def _archive_completeness(content: dict) -> dict:
    """Describe archive evidence honestly instead of turning missing data into zero."""
    account = content.get("account") or {}
    engagement = content.get("engagement") or {}
    video = (content.get("media_assets") or {}).get("video") or {}
    images = content.get("images") or []
    checks = {
        "title": bool(content.get("post_title") or content.get("title")),
        "body": bool(
            content.get("post_description") or content.get("page_text")
            or content.get("video_text") or content.get("audio_text")
        ),
        "source_url": bool(content.get("source_url")),
        "platform_content_id": bool(content.get("platform_content_id")),
        "published_at": bool(content.get("published_at")),
        "account": bool(account.get("name") or account.get("profile_url")),
        "engagement": any(engagement.get(key) not in (None, "") for key in (
            "likes", "collects", "comments", "shares", "views"
        )),
        "cover": bool(
            images or video.get("cover_filename") or video.get("cover_image_b64")
        ),
        "primary_media": bool(
            images if content.get("media_type") == "image_post"
            else video.get("filename")
        ),
    }
    missing = [key for key, available in checks.items() if not available]
    score = round(100 * (len(checks) - len(missing)) / len(checks))
    return {
        "status": "complete" if not missing else "partial",
        "score": score,
        "missing_fields": missing,
        "checks": checks,
    }


def _safe_export_name(value, fallback="content"):
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", str(value or "")).strip(" ._")
    return (cleaned[:60] or fallback)


def _build_export_text(content, export_format="txt"):
    engagement = content.get("engagement") or {}
    account = content.get("account") or empty_account()
    storage = content.get("storage") or {}
    mode_label = content.get("collection_mode_label") or content.get("collection_mode") or ""
    topics = content.get("topics") or []
    is_markdown = export_format == "md"
    cover_title = content.get("cover_title") or ""
    post_title = content.get("post_title") or content.get("title") or ""
    post_description = (
        content.get("post_description")
        if "post_description" in content
        else content.get("description") or ""
    )
    title = content.get("display_title") or cover_title or post_title or "未命名内容"
    if is_markdown:
        sections = [
            f"# {title}",
            "\n".join([
                f"- 来源：{content.get('source_url') or ''}",
                f"- 采集模式：{mode_label}",
                f"- 素材策略：{storage.get('policy') or ''}",
                f"- 点赞量：{engagement.get('likes') or '—'}",
                f"- 收藏量：{engagement.get('collects') or '—'}",
                f"- 评论量：{engagement.get('comments') or '—'}",
                f"- 话题：{' '.join('#' + item for item in topics) or '—'}",
            ]),
            "## 账号基础数据\n" + "\n".join([
                f"- 账号名称：{account.get('name') or ''}",
                f"- 主页链接：{account.get('profile_url') or ''}",
                f"- 简介：{account.get('bio') or ''}",
                f"- 关注量：{account.get('following_count') or ''}",
                f"- 粉丝量：{account.get('follower_count') or ''}",
                f"- 获赞与收藏量：{account.get('likes_and_collections_count') or ''}",
            ]),
        ]
        heading = lambda value: f"## {value}"
    else:
        sections = [
            f"标题：{title}",
            f"来源：{content.get('source_url') or ''}",
            f"采集模式：{mode_label}",
            f"素材策略：{storage.get('policy') or ''}",
            f"点赞量：{engagement.get('likes') or '—'}",
            f"收藏量：{engagement.get('collects') or '—'}",
            f"评论量：{engagement.get('comments') or '—'}",
            f"话题：{' '.join('#' + item for item in topics) or '—'}",
            "账号基础数据：\n" + "\n".join([
                f"账号名称：{account.get('name') or ''}",
                f"主页链接：{account.get('profile_url') or ''}",
                f"简介：{account.get('bio') or ''}",
                f"关注量：{account.get('following_count') or ''}",
                f"粉丝量：{account.get('follower_count') or ''}",
                f"获赞与收藏量：{account.get('likes_and_collections_count') or ''}",
            ]),
        ]
        heading = lambda value: value + "："

    for label, value in (("封面标题", cover_title), ("文字标题", post_title),
                         ("作品描述", post_description)):
        if value:
            sections.append(f"{heading(label)}\n{value}")

    if content.get("page_text") and not content.get("images"):
        sections.append(f"{heading('帖子正文')}\n{content['page_text']}")
    video_text_label = (
        "视频模型逐段识别"
        if (content.get("video_text_meta") or {}).get("method") in {
            "moxus_video", "openrouter_video"
        }
        else "视频画面文字"
    )
    for label, key in ((video_text_label, "video_text"), ("语音转写", "audio_text")):
        if content.get(key):
            sections.append(f"{heading(label)}\n{content[key]}")

    image_parts = []
    for item in content.get("images") or []:
        details = [f"{heading('正文图片 ' + str(item.get('index') or ''))}"]
        if item.get("source_url"):
            details.append(f"原图链接：{item['source_url']}")
        if item.get("text"):
            details.append(f"OCR：\n{item['text']}")
        image_parts.append("\n".join(details))
    if image_parts:
        sections.append("\n\n".join(image_parts))

    comments = content.get("comments") or []
    if comments:
        lines = [heading("高赞评论（含回复）")]
        for index, item in enumerate(comments, 1):
            kind = "回复" if item.get("type") == "reply" else "评论"
            reply_to = f" → @{item['reply_to_author']}" if item.get("reply_to_author") else ""
            lines.append(
                f"{index}. [{kind}] {item.get('author') or '匿名'}{reply_to} "
                f"· {item.get('like_count', 0)} 赞\n{item.get('text') or ''}"
            )
        sections.append("\n\n".join(lines))

    ai_analysis = content.get("ai_analysis") or {}
    video_analysis = ai_analysis.get("video") or {}
    video_items = video_analysis.get("items") or {}
    if video_items:
        lines = [heading("AI 视频分析")]
        for key in (
            "main_topic", "target_audience", "user_need", "content_structure",
            "solution", "references", "extensions",
        ):
            item = video_items.get(key) or {}
            if item.get("summary"):
                lines.append(f"{item.get('label') or key}：{item['summary']}")
        sections.append("\n\n".join(lines))

    comment_analysis = ai_analysis.get("comments") or {}
    comment_items = comment_analysis.get("items") or {}
    if comment_items:
        lines = [heading("AI 评论需求分析")]
        for key in ("main_questions", "high_frequency_needs", "worries", "unclear_points"):
            item = comment_items.get(key) or {}
            if not item.get("summary"):
                continue
            lines.append(f"{item.get('label') or key}：{item['summary']}")
            for evidence in item.get("evidence_comments") or []:
                lines.append(
                    f"  代表评论｜{evidence.get('author') or '匿名'}"
                    f" · {evidence.get('like_count', 0)} 赞：{evidence.get('text') or ''}"
                )

        key_comments = (comment_items.get("key_comments") or {}).get("entries") or []
        if key_comments:
            lines.append("哪些评论值得重点看：")
            for entry in key_comments:
                evidence = entry.get("comment") or {}
                lines.append(
                    f"  - {entry.get('reason') or ''}\n"
                    f"    原话｜{evidence.get('author') or '匿名'}"
                    f" · {evidence.get('like_count', 0)} 赞：{evidence.get('text') or ''}"
                )

        topic_extensions = (comment_items.get("topic_extensions") or {}).get("entries") or []
        if topic_extensions:
            lines.append("可以延伸什么选题：")
            for entry in topic_extensions:
                lines.append(f"  - {entry.get('idea') or ''}")
                for evidence in entry.get("evidence_comments") or []:
                    lines.append(
                        f"    需求依据｜{evidence.get('author') or '匿名'}：{evidence.get('text') or ''}"
                    )
        sections.append("\n\n".join(lines))

    if ai_analysis.get("notice"):
        sections.append(f"{heading('AI 使用说明')}\n{ai_analysis['notice']}")
    return "\n\n".join(sections) + "\n"


@app.after_request
def disable_page_cache(response):
    """Avoid serving stale JavaScript after UI/API contracts change."""
    if response.mimetype == "text/html":
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return response


def _run_pipeline(
    vid: str, url: str, manual_refresh: bool = False, *,
    session_mode: str = "saved", auto_archive: bool = False,
):
    collection_mode = COLLECTION_MODE
    session_mode = "public" if session_mode == "public" else "saved"
    use_login = session_mode == "saved"
    _running[vid] = {
        "status": "running", "progress": 0, "message": "开始采集...",
        "collection_mode": collection_mode,
        "session_mode": session_mode,
        "auto_archive": bool(auto_archive),
        "manual_refresh": manual_refresh,
    }

    final_task_dir = OUTPUT_DIR / vid
    task_dir = final_task_dir
    refresh_backup_dir = OUTPUT_DIR / f".refresh-backup-{vid}"
    previous_content = {}
    if manual_refresh:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", vid):
            raise ValueError("invalid task id")
        task_dir = OUTPUT_DIR / f".refresh-{vid}"
        if task_dir.resolve().parent != OUTPUT_DIR.resolve():
            raise ValueError("unsafe refresh path")
        shutil.rmtree(task_dir, ignore_errors=True)
        task_dir.mkdir(parents=True, exist_ok=True)
        previous_path = final_task_dir / "content.json"
        try:
            previous_content = json.loads(previous_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous_content = {}
        previous_comments = final_task_dir / "comments.last_good.json"
        if previous_comments.is_file():
            shutil.copy2(previous_comments, task_dir / previous_comments.name)
    task_dir.mkdir(parents=True, exist_ok=True)
    for stale_dir in task_dir.glob("_working_*"):
        if stale_dir.is_dir() and stale_dir.resolve().parent == task_dir.resolve():
            shutil.rmtree(stale_dir, ignore_errors=True)
    working_dir = task_dir / "_working_media"
    last_good_path = task_dir / "comments.last_good.json"
    last_good = {}
    if use_login and last_good_path.exists():
        try:
            last_good = json.loads(last_good_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            last_good = {}

    def progress(pct, msg):
        _running[vid] = {
            "status": "running", "progress": pct, "message": msg,
            "collection_mode": collection_mode,
            "manual_refresh": manual_refresh,
        }

    def update_running_status(**fields):
        if not manual_refresh:
            db.update_status(vid, "running", **fields)

    def add_artifact(artifact_type, path, meta=None):
        if not manual_refresh:
            db.add_artifact(vid, artifact_type, str(path), meta)

    try:
        video_text = ""
        video_text_meta = {}
        audio_text = ""
        page_text = ""
        text_same_as_description = False
        engagement = {"likes": "", "collects": "", "comments": ""}
        topics = []
        image_results = []
        cover_title_info = {}
        title = ""
        description = ""
        author = ""
        platform_content_id = ""
        published_at = ""
        account = empty_account()
        media_type = "video"
        platform = detect_platform(url)
        video_asset = {
            "source_url": url,
            "thumbnail_url": "",
            "duration_seconds": 0,
            "width": 0,
            "height": 0,
            "size_bytes": 0,
            "format": "",
            "video_codec": "",
            "processed_from_temporary_download": False,
        }

        progress(8, "正在读取账号、标题和媒体元数据...")
        video_url_hint = url_declares_video(url)
        meta = extract_video_metadata(url, use_login=use_login)
        if meta:
            platform_content_id = str(meta.get("id") or "")
            published_at = str(meta.get("published_at") or "")
        media_probe = {
            "status": "ok" if meta else ("hint" if video_url_hint else "not_video"),
            "method": "downloader_metadata" if meta else ("source_url" if video_url_hint else "page"),
            "message": (
                "视频元数据识别成功" if meta
                else "链接明确标记为视频，继续尝试下载" if video_url_hint
                else "未发现视频信号，按图文处理"
            ),
        }

        if meta or video_url_hint:
            meta = meta or {}
            page = _run_async(extract_page(url, use_login=use_login)) or {}
            platform_content_id = platform_content_id or page.get("platform_content_id") or ""
            published_at = published_at or page.get("published_at") or ""
            title = page.get("post_title") or page.get("title") or meta.get("title") or "未命名内容"
            topics = page.get("topics") or meta.get("tags") or []
            raw_description = (
                page.get("post_description")
                or page.get("description")
                or meta.get("description")
                or ""
            )
            description = strip_topics_from_description(raw_description, topics)
            author = meta.get("uploader") or ""
            account = merge_accounts(page.get("account"), account_from_downloader(meta))
            metadata_engagement = {
                "likes": "" if meta.get("like_count") is None else str(meta.get("like_count")),
                "collects": "",
                "comments": "" if meta.get("comment_count") is None else str(meta.get("comment_count")),
                "shares": "" if meta.get("repost_count") is None else str(meta.get("repost_count")),
                "views": "" if meta.get("view_count") is None else str(meta.get("view_count")),
            }
            page_engagement = page.get("engagement") or {}
            engagement = {
                key: page_engagement.get(key) or metadata_engagement.get(key) or ""
                for key in ("likes", "collects", "comments", "shares", "views")
            }
            video_asset.update({
                "source_url": meta.get("webpage_url") or url,
                "thumbnail_url": meta.get("thumbnail") or "",
                "duration_seconds": meta.get("duration") or 0,
                "width": meta.get("width") or 0,
                "height": meta.get("height") or 0,
                "size_bytes": meta.get("filesize") or 0,
                "format": meta.get("format") or "",
                "video_codec": meta.get("vcodec") or "",
            })
            update_running_status(title=title, description=description)

            progress(24, "正在临时读取视频素材...")
            working_dir.mkdir(parents=True, exist_ok=True)
            cover_title_info, cover_asset = _collect_platform_video_cover(
                video_asset["thumbnail_url"], page.get("images") or [],
                working_dir, url, title,
            )
            video_asset.update(cover_asset)
            for cover_path in sorted(working_dir.glob("video_cover.*"))[:1]:
                cover_dest = task_dir / ("cover" + cover_path.suffix.lower())
                shutil.copy2(cover_path, cover_dest)
                video_asset["cover_filename"] = cover_dest.name
                add_artifact("cover", cover_dest, {"archive_quality": "platform_available"})
            downloaded = download_video(
                url, str(working_dir), metadata=meta if meta else None,
                use_login=use_login,
            )
            if downloaded:
                video_path = downloaded["video_path"]
                archived_video = task_dir / "video.mp4"
                shutil.copy2(video_path, archived_video)
                video_asset.update({
                    "filename": archived_video.name,
                    "archive_quality": "bounded_720p",
                    "archive_original_bytes": False,
                    "size_bytes": Path(video_path).stat().st_size,
                    "processed_from_temporary_download": True,
                    "duration_seconds": video_asset["duration_seconds"] or downloaded.get("duration") or 0,
                    "width": video_asset["width"] or downloaded.get("width") or 0,
                    "height": video_asset["height"] or downloaded.get("height") or 0,
                    "format": video_asset["format"] or downloaded.get("format") or "",
                    "video_codec": video_asset["video_codec"] or downloaded.get("vcodec") or "",
                })
                media_probe.update(
                    status="ok", method="video_download", message="视频素材读取成功"
                )
                add_artifact("video", archived_video, {
                    "archive_quality": "bounded_720p",
                    "source_url": url,
                })

                progress(38, "正在使用视频模型连续识别画面文字...")
                model_video_text = transcribe_video_with_model(
                    video_path, str(working_dir / "video_model")
                )
                video_text = model_video_text.get("text") or ""
                video_text_meta = {
                    key: value for key, value in model_video_text.items() if key != "text"
                }
                if not video_text:
                    progress(46, "视频模型不可用，正在使用本地抽帧 OCR 兜底...")
                    video_text = extract_video_text(video_path)
                    video_text_meta = {
                        "status": "fallback" if video_text else "unavailable",
                        "method": "frame_ocr",
                        "interval_seconds": 3.0,
                        "fallback_reason": model_video_text.get("message") or "视频模型未返回文字",
                    }
                if video_text:
                    video_ocr_path = task_dir / "video_ocr.txt"
                    _atomic_write_text(video_ocr_path, video_text)
                    add_artifact("video_ocr", video_ocr_path)

                progress(56, "正在整理字幕识别结果...")
            else:
                media_probe.update(
                    status="unavailable",
                    method="video_download",
                    message="已识别为视频，但视频素材暂时无法读取",
                )
                video_text_meta = {
                    "status": "unavailable",
                    "method": "video_download",
                    "message": "视频素材下载失败，未执行字幕识别",
                }
        else:
            media_type = "image_post"
            progress(20, "正在解析图文页面与原始素材链接...")
            page = _run_async(extract_page(url, use_login=use_login))

            if not page:
                raise RuntimeError("无法提取内容。该链接可能需要登录 Cookie，或已失效。")

            page_text = page.get("text", "")
            platform_content_id = page.get("platform_content_id") or ""
            published_at = page.get("published_at") or ""
            text_same_as_description = bool(page.get("text_same_as_description"))
            engagement = page.get("engagement") or engagement
            topics = page.get("topics") or []
            title = page.get("post_title") or page["title"]
            description = page.get("post_description", page.get("description", ""))
            account = page.get("account") or account
            update_running_status(title=title, description=description)

            image_urls = page.get("images") or []
            image_diagnostics = {
                "discovered": len(image_urls),
                "downloaded": 0,
                "failed": 0,
                "rejected_payload": 0,
                "rejected_dimensions": 0,
            }
            if image_urls:
                progress(42, "正在下载原图并进行 OCR...")
                image_downloads = download_post_images(
                    image_urls, str(task_dir), url, diagnostics=image_diagnostics,
                )
                image_results = extract_images_text(image_downloads)
                if image_results:
                    cover_title_info = image_results[0].get("cover_title") or {}
                for item in image_results:
                    add_artifact("image", item["path"], {"ocr_text": item["text"]})
            media_probe.update({
                "status": "ok" if image_results else "unavailable",
                "method": "page_image_download",
                "message": (
                    f"已保存 {len(image_results)} 张正文图片"
                    if image_results
                    else (
                        "页面未发现正文图片链接"
                        if not image_urls
                        else "发现正文图片链接，但素材下载或校验未通过"
                    )
                ),
                **image_diagnostics,
            })

        progress(70, "正在获取博主账号基础数据...")
        account = _run_async(hydrate_account(
            url, platform, account, use_login=use_login,
        ))
        if manual_refresh:
            account = merge_accounts(account, previous_content.get("account"))
            previous_engagement = previous_content.get("engagement") or {}
            engagement = {
                key: engagement.get(key) or previous_engagement.get(key) or ""
                for key in ("likes", "collects", "comments", "shares", "views")
            }
            title = title or previous_content.get("post_title") or previous_content.get("title") or ""
            description = description or previous_content.get("post_description") or previous_content.get("description") or ""
        account_status = _account_collection_status(account)
        author = account.get("name") or author
        update_running_status(account_name=author)

        progress(80, "正在筛选高赞评论与回复...")
        comment_result = _run_async(extract_hot_comments(
            url, platform, use_login=use_login,
        ))

        fresh_summary = comment_result.get("comment_summary") or {}
        fresh_comments = comment_result.get("comments") or []
        if (use_login and platform == "xiaohongshu"
                and fresh_summary.get("status") == "login_required"):
            invalidate_xhs_login()
            _cancel_login_attempt("idle", "登录态已失效，请重新扫码")
        comment_result = _preserve_last_good_comments(comment_result, last_good)
        if fresh_comments and fresh_summary.get("status") in {"ok", "partial"}:
            _atomic_write_text(
                last_good_path,
                json.dumps(comment_result, ensure_ascii=False, indent=2),
            )

        progress(88, "正在生成 AI 视频与评论需求分析...")
        content = {
            "schema_version": CONTENT_SCHEMA_VERSION,
            "task_id": vid,
            "collected_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "manual_refresh": manual_refresh,
            "source_url": url,
            "platform_content_id": platform_content_id,
            "published_at": published_at,
            "platform": platform,
            "collection_mode": collection_mode,
            "collection_mode_label": COLLECTION_MODE_LABEL,
            "session_mode": session_mode,
            "session_mode_label": "公开无登录" if session_mode == "public" else "使用采集账号",
            "storage": {
                "policy": STORAGE_POLICY,
                "local_media_retained": bool(
                    image_results if media_type == "image_post" else video_asset.get("filename")
                ),
                "temporary_media_deleted": False,
                "archive_quality": (
                    "original_images" if media_type == "image_post"
                    else video_asset.get("archive_quality") or "unavailable"
                ),
            },
            "media_type": media_type,
            "media_assets": {"video": video_asset if media_type == "video" else {}},
            "title": title,
            "description": description,
            "cover_title": cover_title_info.get("text") or "",
            "cover_title_meta": cover_title_info,
            "post_title": title,
            "post_description": description,
            "display_title": cover_title_info.get("text") or title,
            "author": author,
            "account": account,
            "collection_status": {
                "media": media_probe,
                "account": account_status,
            },
            "page_text": page_text,
            "text_same_as_description": text_same_as_description,
            "engagement": engagement,
            "topics": topics,
            "video_text": video_text,
            "video_text_meta": video_text_meta,
            "audio_text": audio_text,
            "comments": comment_result["comments"],
            "comment_summary": comment_result["comment_summary"],
            "images": [
                {
                    "index": index,
                    "filename": Path(item.get("path") or "").name,
                    "text": item.get("text") or "",
                    "width": item.get("width") or 0,
                    "height": item.get("height") or 0,
                    "size_bytes": item.get("size_bytes") or 0,
                    "source_url": item.get("source_url") or "",
                }
                for index, item in enumerate(image_results, 1)
            ],
        }
        content["archive_completeness"] = _archive_completeness(content)
        content["ai_analysis"], technical_audit = analyze_content_with_audit(content)

        progress(96, "正在整理并保存分析结果...")
        json_path = task_dir / "content.json"
        _atomic_write_text(json_path, json.dumps(content, ensure_ascii=False, indent=2))

        if auto_archive:
            if not IDEAHUB_API_KEY:
                content["sample_archive"] = {
                    "status": "failed",
                    "message": "IdeaHub 样本归档密钥尚未配置",
                }
            else:
                try:
                    archived = _post_ideahub_sample(content)
                    content["sample_archive"] = {
                        "status": "done",
                        "sample_id": archived.get("sampleId") or archived.get("id"),
                        "capture_id": archived.get("captureId"),
                    }
                except Exception as exc:
                    content["sample_archive"] = {
                        "status": "failed",
                        "message": public_error_message(
                            exc, fallback="样本自动归档失败，可稍后重试"
                        ),
                    }
            _atomic_write_text(
                json_path, json.dumps(content, ensure_ascii=False, indent=2)
            )

        text_path = task_dir / "content.txt"
        _atomic_write_text(text_path, _build_export_text(content, "txt"))

        audit_json_path = task_dir / "ai_analysis.technical.json"
        _atomic_write_text(
            audit_json_path,
            json.dumps(technical_audit, ensure_ascii=False, indent=2),
        )
        audit_md_path = task_dir / "ai_analysis.technical.md"
        _atomic_write_text(
            audit_md_path,
            build_technical_audit_markdown(technical_audit),
        )

        add_artifact("content_json", json_path)
        add_artifact("content_text", text_path)
        add_artifact("ai_analysis_technical_json", audit_json_path, {"audience": "technical"})
        add_artifact("ai_analysis_technical_md", audit_md_path, {"audience": "technical"})

        if working_dir.is_dir() and working_dir.resolve().parent == task_dir.resolve():
            shutil.rmtree(working_dir, ignore_errors=True)

        if manual_refresh:
            shutil.rmtree(refresh_backup_dir, ignore_errors=True)
            final_task_dir.replace(refresh_backup_dir)
            try:
                task_dir.replace(final_task_dir)
            except Exception:
                refresh_backup_dir.replace(final_task_dir)
                raise
        db.update_status(
            vid, "done", title=cover_title_info.get("text") or title, description=description,
            account_name=account.get("name") or author,
        )
        if manual_refresh:
            shutil.rmtree(refresh_backup_dir, ignore_errors=True)

        _running[vid] = {
            "status": "done", "progress": 100,
            "message": "最新数据获取完成" if manual_refresh else f"{COLLECTION_MODE_LABEL}完成",
            "collection_mode": collection_mode,
            "manual_refresh": manual_refresh,
        }

    except Exception as e:
        safe_message = public_error_message(e, fallback="内容采集失败，请稍后重试")
        app.logger.error(
            "Pipeline failed for task %s (%s)", vid, e.__class__.__name__
        )
        _running[vid] = {
            "status": "failed", "progress": 0, "message": safe_message,
            "collection_mode": collection_mode,
            "manual_refresh": manual_refresh,
        }
        if manual_refresh:
            if refresh_backup_dir.is_dir():
                shutil.rmtree(final_task_dir, ignore_errors=True)
                refresh_backup_dir.replace(final_task_dir)
        else:
            db.update_status(vid, "failed", error_msg=safe_message)
    finally:
        if working_dir.is_dir() and working_dir.resolve().parent == task_dir.resolve():
            shutil.rmtree(working_dir, ignore_errors=True)
        if manual_refresh and task_dir.is_dir() and task_dir.resolve().parent == OUTPUT_DIR.resolve():
            shutil.rmtree(task_dir, ignore_errors=True)


def _run_pipeline_in_slot(
    vid: str, url: str, manual_refresh: bool = False, *,
    session_mode: str = "saved", auto_archive: bool = False,
):
    """Run one collection pipeline within the configured single-VPS bound."""
    with _pipeline_slots:
        _run_pipeline(
            vid, url, manual_refresh=manual_refresh, session_mode=session_mode,
            auto_archive=auto_archive,
        )


@app.route("/")
def index():
    return render_template("index.html")


def _run_xhs_login(generation: int, force_fresh=False):
    def update(status, message, **public_state):
        return _update_login_generation(
            generation, status, message, **public_state
        )

    try:
        asyncio.run(login_xiaohongshu(
            update,
            force_fresh=force_fresh,
            is_current=lambda: _login_generation_is_current(generation),
            publish_qr=lambda temp_path: _publish_login_qr(generation, temp_path),
            commit_session=lambda cookies, state, profile: _commit_login_session(
                generation, cookies, state, profile, clear_label=force_fresh,
            ),
            cleanup_qr=lambda: _cleanup_login_qr(generation),
            qr_file=XHS_QR_FILE,
        ))
    except Exception as exc:
        saved = has_saved_xhs_login()
        update("saved" if saved else "failed", friendly_xhs_login_error(exc, saved=saved))


def _run_xhs_account_sync():
    """Refresh the public identity without occupying the only HTTP worker."""
    try:
        with _pipeline_slots:
            asyncio.run(sync_saved_xhs_account())
    except Exception as exc:
        saved = has_saved_xhs_login()
        with _login_state_lock:
            if _login_state.get("status") != "syncing":
                return
            _login_state.update(
                status="saved" if saved else "failed",
                message=friendly_xhs_login_error(exc, saved=saved),
            )
        return
    with _login_state_lock:
        if _login_state.get("status") == "syncing":
            _login_state.update(status="saved", message="当前登录账号已同步")


def _xhs_login_payload():
    with _login_state_lock:
        state = {
            key: _login_state.get(key)
            for key in ("status", "message", "qr_available", "expires_at")
        }
        state["saved"] = has_saved_xhs_login()
        account = read_xhs_login_profile()
        state["account"] = account
        state["account_label"] = read_xhs_login_label()
        state["identity_verified"] = any(
            account.get(key) for key in ("nickname", "red_id", "user_id")
        )
        return state


@app.route("/api/login/xiaohongshu", methods=["POST"])
def api_login_xiaohongshu():
    global _login_generation
    body = request.get_json(silent=True) or {}
    force_fresh = body.get("force_fresh") is True or body.get("mode") == "switch"
    message = "正在打开小红书账号切换窗口…" if force_fresh else "正在打开小红书登录窗口…"
    with _login_state_lock:
        if _login_state.get("status") in {"opening", "waiting_scan", "syncing"}:
            payload = {
                key: _login_state.get(key)
                for key in ("status", "message", "qr_available", "expires_at")
            }
            return jsonify(payload), 409
        if any(
            state.get("status") in {"pending", "running"}
            for state in _running.values()
        ):
            return jsonify({"error": "有采集任务正在使用平台登录态，请完成后再切换账号"}), 409
        _login_generation += 1
        generation = _login_generation
        XHS_QR_FILE.unlink(missing_ok=True)
        _login_state.update(
            status="opening", message=message, qr_available=False, expires_at=None
        )
        payload = {
            key: _login_state.get(key)
            for key in ("status", "message", "qr_available", "expires_at")
        }
    threading.Thread(
        target=_run_xhs_login, args=(generation, force_fresh), daemon=True
    ).start()
    return jsonify(payload)


@app.route("/api/login/xiaohongshu/status")
def api_login_xiaohongshu_status():
    return jsonify(_xhs_login_payload())


@app.route("/api/login/xiaohongshu/qr")
def api_login_xiaohongshu_qr():
    with _login_state_lock:
        expires_at = int(_login_state.get("expires_at") or 0)
    if expires_at and time.time() >= expires_at:
        _cancel_login_attempt("expired", "二维码已过期，请重新发起登录")
        return jsonify({"error": "二维码已过期"}), 410
    with _login_state_lock:
        if not _login_state.get("qr_available") or not XHS_QR_FILE.is_file():
            return jsonify({"error": "二维码尚未生成"}), 404
        qr_bytes = XHS_QR_FILE.read_bytes()
    return send_file(
        BytesIO(qr_bytes), mimetype="image/png", conditional=False, max_age=0
    )


@app.route("/api/login/xiaohongshu/account", methods=["POST"])
def api_login_xiaohongshu_account():
    with _login_state_lock:
        if _login_state.get("status") in {"opening", "waiting_scan", "syncing"}:
            return jsonify(_xhs_login_payload()), 409
        if any(
            state.get("status") in {"pending", "running"}
            for state in _running.values()
        ):
            return jsonify({"error": "有采集任务正在使用平台登录态，请完成后再同步账号"}), 409
        if not has_saved_xhs_login():
            _login_state.update(status="idle", message="请先登录小红书账号")
            return jsonify(_xhs_login_payload()), 409
        _login_state.update(status="syncing", message="正在读取当前登录账号…")
    payload = _xhs_login_payload()
    threading.Thread(target=_run_xhs_account_sync, daemon=True).start()
    return jsonify(payload)


@app.route("/api/login/xiaohongshu/label", methods=["POST"])
def api_login_xiaohongshu_label():
    if not has_saved_xhs_login():
        return jsonify({"error": "请先登录采集账号"}), 409
    body = request.get_json(silent=True) or {}
    try:
        label = save_xhs_login_label(body.get("label", ""))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    with _login_state_lock:
        _login_state.update(
            status="saved",
            message="采集账号备注已保存" if label else "采集账号备注已清除",
        )
    return jsonify(_xhs_login_payload())


@app.route("/api/login/xiaohongshu/logout", methods=["POST"])
def api_logout_xiaohongshu():
    with _login_state_lock:
        if _login_state.get("status") == "syncing":
            return jsonify({"error": "正在确认当前登录账号，请稍后再退出"}), 409
        if any(
            state.get("status") in {"pending", "running"}
            for state in _running.values()
        ):
            return jsonify({"error": "有采集任务正在运行，请完成后再退出账号"}), 409
    _cancel_login_attempt("idle", "采集账号已退出")
    clear_xhs_login_session(clear_label=True)
    with _login_state_lock:
        _login_state.update(
            status="idle", message="采集账号已退出", qr_available=False,
            expires_at=None,
        )
    return jsonify(_xhs_login_payload())


@app.route("/api/convert", methods=["POST"])
def api_convert():
    data = request.get_json() or {}
    url = resolve_share_url(data.get("url", ""))
    if not url:
        return jsonify({"error": "URL required"}), 400
    try:
        url = validate_public_url(url)
    except UnsafeUrl as exc:
        return jsonify({"error": str(exc)}), 400
    collection_mode = COLLECTION_MODE
    session_mode = "public" if data.get("session_mode") == "public" else "saved"
    auto_archive = data.get("auto_archive") is True
    owner_id = str(request.headers.get("X-IdeaHub-User-Id") or "").strip()[:128]
    if not owner_id:
        return jsonify({"error": "缺少任务创建者身份"}), 400

    equivalent_task = _find_equivalent_task(url, owner_id)
    vid = equivalent_task["id"] if equivalent_task else _owner_task_id(url, owner_id)
    existing = db.get_task(vid)
    content_path = OUTPUT_DIR / vid / "content.json"
    if existing and existing["status"] == "done" and content_path.exists():
        try:
            cached_content = json.loads(content_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cached_content = {}
        summary = cached_content.get("comment_summary") or {}
        cached_session_mode = cached_content.get("session_mode") or "saved"
        needs_login_retry = (
            session_mode == "saved"
            and cached_content.get("platform") == "xiaohongshu"
            and has_saved_xhs_login()
            and (summary.get("status") in {"login_required", "unavailable"}
                 or summary.get("likes_obscured"))
        )
        cached_mode = cached_content.get("collection_mode") or "archive"
        if (cached_content.get("schema_version", 0) >= CONTENT_SCHEMA_VERSION
                and "account" in cached_content
                and "comments" in cached_content
                and "ai_analysis" in cached_content
                and cached_mode == collection_mode
                and cached_session_mode == session_mode
                and (not auto_archive
                     or (cached_content.get("sample_archive") or {}).get("status") == "done")
                and not needs_login_retry):
            return jsonify({
                "task_id": vid, "status": "done", "cached": True,
                "collection_mode": cached_mode,
                "session_mode": cached_session_mode,
                "owner_id": existing.get("owner_id") or owner_id,
            })

    # Reserve the task before starting its worker. Without this guard, login
    # auto-refresh and a manual submission can run the same task concurrently;
    # whichever worker finishes last would overwrite the better result.
    with _task_state_lock:
        active = _running.get(vid) or {}
        if active.get("status") in {"pending", "running"}:
            active_mode = active.get("collection_mode") or COLLECTION_MODE
            return jsonify({
                "task_id": vid, "status": active.get("status"), "coalesced": True,
                "collection_mode": active_mode,
                "session_mode": active.get("session_mode") or session_mode,
                "auto_archive": active.get("auto_archive") is True,
                "max_concurrent": MAX_CONCURRENT_TASKS,
                "owner_id": existing.get("owner_id") if existing else owner_id,
            })
        active_count = sum(
            1 for state in _running.values()
            if state.get("status") in {"pending", "running"}
        )
        if active_count >= MAX_CONCURRENT_TASKS + COLLECTOR_MAX_QUEUE:
            return jsonify({"error": "采集队列已满，请稍后重试"}), 429
        _running[vid] = {
            "status": "pending", "progress": 0, "message": "等待并发槽位...",
            "collection_mode": collection_mode,
            "session_mode": session_mode,
            "auto_archive": auto_archive,
        }
        db.create_task(vid, url, detect_platform(url), owner_id=owner_id)
        threading.Thread(
            target=_run_pipeline_in_slot, args=(vid, url),
            kwargs={
                "session_mode": session_mode,
                "auto_archive": auto_archive,
            }, daemon=True,
        ).start()
    return jsonify({
        "task_id": vid,
        "status": "pending",
        "collection_mode": collection_mode,
        "session_mode": session_mode,
        "auto_archive": auto_archive,
        "max_concurrent": MAX_CONCURRENT_TASKS,
        "owner_id": owner_id,
    })


@app.route("/api/status/<vid>")
def api_status(vid):
    t = db.get_task(vid)
    if vid in _running:
        return jsonify({**_running[vid], "owner_id": (t or {}).get("owner_id") or ""})
    if t:
        pct = 100 if t["status"] == "done" else 0
        return jsonify({"status": t["status"], "progress": pct, "message": t.get("error_msg", ""), "owner_id": t.get("owner_id") or ""})
    return jsonify({"status": "unknown"})


@app.route("/api/task/<vid>/refresh", methods=["POST"])
def api_refresh_task(vid):
    """Start one user-requested refresh without creating a new history row."""
    task_dir = _resolve_task_dir(vid)
    if task_dir is None:
        return jsonify({"error": "invalid task id"}), 400
    task = db.get_task(vid)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    if task.get("status") != "done" or not (task_dir / "content.json").is_file():
        return jsonify({"error": "仅已完成且有结果的作品可以更新"}), 409
    try:
        previous_content = json.loads(
            (task_dir / "content.json").read_text(encoding="utf-8")
        )
    except (OSError, json.JSONDecodeError):
        previous_content = {}
    session_mode = (
        "public" if previous_content.get("session_mode") == "public" else "saved"
    )

    with _task_state_lock:
        active = _running.get(vid) or {}
        if active.get("status") in {"pending", "running"}:
            return jsonify({"error": "该作品正在采集或更新中", **active}), 409
        active_count = sum(
            1 for state in _running.values()
            if state.get("status") in {"pending", "running"}
        )
        if active_count >= MAX_CONCURRENT_TASKS + COLLECTOR_MAX_QUEUE:
            return jsonify({"error": "采集队列已满，请稍后再更新"}), 429
        _running[vid] = {
            "status": "pending",
            "progress": 0,
            "message": "等待更新并发槽位...",
            "collection_mode": COLLECTION_MODE,
            "session_mode": session_mode,
            "manual_refresh": True,
        }
        threading.Thread(
            target=_run_pipeline_in_slot,
            args=(vid, task["url"], True),
            kwargs={"session_mode": session_mode},
            daemon=True,
        ).start()
    return jsonify({
        "task_id": vid,
        "status": "pending",
        "manual_refresh": True,
        "session_mode": session_mode,
        "max_concurrent": MAX_CONCURRENT_TASKS,
    })


def _backfill_content_fields(content, image_dir):
    """Upgrade saved results without requiring the user to collect them again."""
    changed = False
    topics = content.get("topics") or []
    post_title = clean_post_title(content.get("post_title") or content.get("title") or "")
    raw_description = (
        content.get("post_description")
        if "post_description" in content
        else content.get("description", "")
    )
    post_description = strip_topics_from_description(raw_description or "", topics)

    updates = {
        "post_title": post_title,
        "post_description": post_description,
        "title": post_title,
        "description": post_description,
    }
    for key, value in updates.items():
        if content.get(key) != value:
            content[key] = value
            changed = True

    cover_title_info = content.get("cover_title_meta") or {}
    cover_title = content.get("cover_title") or cover_title_info.get("text") or ""
    if not cover_title:
        images = content.get("images") or []
        filename = images[0].get("filename", "") if images else ""
        image_path = image_dir / filename if filename else None
        if image_path and image_path.is_file():
            cover_title_info = extract_cover_title_from_path(str(image_path))
            cover_title = cover_title_info.get("text") or ""

    for key, value in (
        ("cover_title", cover_title),
        ("cover_title_meta", cover_title_info),
        ("display_title", cover_title or post_title),
    ):
        if content.get(key) != value:
            content[key] = value
            changed = True

    if int(content.get("schema_version") or 0) < 9:
        content["schema_version"] = 9
        changed = True
    return changed


def _backfill_video_evidence(content, task_dir=None):
    """Fill missing video/profile fields in older saved results without re-downloading media."""
    if (
        int(content.get("schema_version") or 0) >= 13
        or content.get("media_type") != "video"
        or not content.get("source_url")
    ):
        return False

    video_asset = ((content.get("media_assets") or {}).get("video") or {})
    account = content.get("account") or empty_account()
    engagement = content.get("engagement") or {}
    needs_backfill = (
        not account.get("name")
        or not account.get("profile_url")
        or not any(engagement.get(key) for key in ("likes", "collects", "comments"))
        or not video_asset.get("duration_seconds")
        or "[话题]" in str(content.get("post_description") or content.get("description") or "")
        or not content.get("cover_title")
    )
    if not needs_backfill:
        return False

    source_url = content["source_url"]
    platform = content.get("platform") or detect_platform(source_url)
    use_login = content.get("session_mode") != "public"
    meta = extract_video_metadata(source_url, use_login=use_login) or {}
    try:
        page = _run_async(extract_page(source_url, use_login=use_login)) or {}
    except Exception:
        page = {}

    topics = content.get("topics") or page.get("topics") or meta.get("tags") or []
    raw_description = (
        content.get("post_description")
        or content.get("description")
        or page.get("post_description")
        or page.get("description")
        or meta.get("description")
        or ""
    )
    description = strip_topics_from_description(raw_description, topics)
    account = merge_accounts(account, page.get("account"), account_from_downloader(meta))
    try:
        account = _run_async(hydrate_account(
            source_url, platform, account, use_login=use_login,
        ))
    except Exception:
        pass

    page_engagement = page.get("engagement") or {}
    metadata_engagement = {
        "likes": "" if meta.get("like_count") is None else str(meta.get("like_count")),
        "collects": "",
        "comments": "" if meta.get("comment_count") is None else str(meta.get("comment_count")),
        "shares": "" if meta.get("repost_count") is None else str(meta.get("repost_count")),
        "views": "" if meta.get("view_count") is None else str(meta.get("view_count")),
    }
    engagement = {
        key: engagement.get(key) or page_engagement.get(key) or metadata_engagement.get(key) or ""
        for key in ("likes", "collects", "comments", "shares", "views")
    }
    video_asset = {
        **video_asset,
        "source_url": meta.get("webpage_url") or video_asset.get("source_url") or source_url,
        "thumbnail_url": meta.get("thumbnail") or video_asset.get("thumbnail_url") or "",
        "duration_seconds": meta.get("duration") or video_asset.get("duration_seconds") or 0,
        "width": meta.get("width") or video_asset.get("width") or 0,
        "height": meta.get("height") or video_asset.get("height") or 0,
        "size_bytes": meta.get("filesize") or video_asset.get("size_bytes") or 0,
        "format": meta.get("format") or video_asset.get("format") or "",
        "video_codec": meta.get("vcodec") or video_asset.get("video_codec") or "",
    }
    cover_title_info = content.get("cover_title_meta") or {}
    cover_title = content.get("cover_title") or cover_title_info.get("text") or ""
    cover_working_dir = None
    if not cover_title and task_dir and video_asset.get("thumbnail_url"):
        cover_working_dir = Path(task_dir) / "_working_cover"
        try:
            cover_title_info, cover_asset = _collect_platform_video_cover(
                video_asset["thumbnail_url"], page.get("images") or [],
                cover_working_dir, source_url,
                content.get("post_title") or content.get("title") or "",
            )
            video_asset.update(cover_asset)
            cover_title = cover_title_info.get("text") or ""
        finally:
            if (cover_working_dir.is_dir()
                    and cover_working_dir.resolve().parent == Path(task_dir).resolve()):
                shutil.rmtree(cover_working_dir, ignore_errors=True)
    content.update({
        "topics": topics,
        "post_description": description,
        "description": description,
        "account": account,
        "author": account.get("name") or content.get("author") or "",
        "engagement": engagement,
        "media_assets": {**(content.get("media_assets") or {}), "video": video_asset},
        "cover_title": cover_title,
        "cover_title_meta": cover_title_info,
        "display_title": cover_title or content.get("post_title") or content.get("title") or "",
    })
    return True


@app.route("/api/result/<vid>")
def api_result(vid):
    task = db.get_task(vid)
    if not task:
        return jsonify({"error": "任务不存在", "status": "unknown"}), 404
    if task["status"] == "failed":
        return jsonify({
            "error": task.get("error_msg") or "内容采集失败",
            "status": "failed",
        }), 409
    if task["status"] != "done":
        return jsonify({"error": "结果仍在生成中", "status": task["status"]}), 409

    task_dir = OUTPUT_DIR / vid
    content_path = task_dir / "content.json"
    if not content_path.exists():
        return jsonify({"error": "result file not found"}), 404
    content = json.loads(content_path.read_text(encoding="utf-8"))
    image_dir = task_dir / "images"
    changed = _backfill_content_fields(content, image_dir)
    if _backfill_video_evidence(content, task_dir):
        changed = True
    if changed:
        _atomic_write_text(content_path, json.dumps(content, ensure_ascii=False, indent=2))
    display_title = content.get("display_title") or content.get("post_title")
    if display_title and task.get("title") != display_title:
        db.update_status(vid, "done", title=display_title)
    gallery = []
    for item in content.get("images", []):
        filename = item.get("filename", "")
        image_path = image_dir / filename
        if filename and image_path.is_file():
            try:
                with Image.open(image_path) as image:
                    width, height = image.size
            except Exception:
                continue
            if max(width, height) < 800:
                continue
            gallery.append({
                **item,
                "index": len(gallery) + 1,
                "width": width,
                "height": height,
                "size_bytes": image_path.stat().st_size,
                "url": f"/api/image/{vid}/{filename}",
                "download_url": f"/api/image/{vid}/{filename}?download=1",
                "stored_locally": True,
            })
        elif item.get("source_url"):
            gallery.append({
                **item,
                "index": len(gallery) + 1,
                "url": item["source_url"],
                "download_url": item["source_url"],
                "stored_locally": False,
            })
    content["images"] = gallery

    media_assets = content.get("media_assets") or {}
    video_asset = media_assets.get("video") or {}
    video_filename = video_asset.get("filename") or ""
    video_path = OUTPUT_DIR / vid / video_filename
    if video_filename and video_path.is_file():
        video_asset = {
            **video_asset,
            "url": f"/api/media/{vid}/{video_filename}",
            "download_url": f"/api/media/{vid}/{video_filename}?download=1",
            "stored_locally": True,
        }
    elif video_asset:
        video_asset = {**video_asset, "stored_locally": False}
    content["media_assets"] = {**media_assets, "video": video_asset}
    audit_formats = [
        audit_format
        for audit_format in ("json", "md")
        if (task_dir / f"ai_analysis.technical.{audit_format}").is_file()
    ]
    content["technical_audit"] = {
        "available": bool(audit_formats),
        "formats": audit_formats,
        "local_access": _is_local_request(),
    }
    content["data_updated_at"] = content.get("collected_at") or task.get("updated_at") or ""
    content["owner_id"] = task.get("owner_id") or ""
    return jsonify(content)


@app.route("/api/result/<vid>/ai-analysis", methods=["PATCH"])
def api_update_ai_analysis(vid):
    task = db.get_task(vid)
    if not task:
        return jsonify({"error": "任务不存在"}), 404
    if task.get("status") != "done":
        return jsonify({"error": "任务完成后才能编辑 AI 分析"}), 409

    task_dir = _resolve_task_dir(vid)
    if task_dir is None:
        return jsonify({"error": "unsafe task path"}), 400
    content_path = task_dir / "content.json"
    if not content_path.is_file():
        return jsonify({"error": "result file not found"}), 404
    payload = request.get_json(silent=True)

    with _content_write_lock:
        try:
            content = json.loads(content_path.read_text(encoding="utf-8"))
            analysis = _apply_ai_analysis_edits(content, payload)
            _atomic_write_text(
                content_path,
                json.dumps(content, ensure_ascii=False, indent=2),
            )
            _atomic_write_text(
                task_dir / "content.txt",
                _build_export_text(content, "txt"),
            )
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except (OSError, json.JSONDecodeError):
            return jsonify({"error": "保存 AI 分析失败，请稍后重试"}), 500

    return jsonify({
        "ok": True,
        "ai_analysis": analysis,
        "edited_at": analysis["manual_edit"]["edited_at"],
    })


@app.route("/api/image/<vid>/<path:filename>")
def api_image(vid, filename):
    image_dir = OUTPUT_DIR / vid / "images"
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    mime_type = {"webp": "image/webp", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}.get(suffix)
    return send_from_directory(
        str(image_dir), filename,
        mimetype=mime_type,
        as_attachment=request.args.get("download") == "1",
        download_name=filename,
    )


@app.route("/api/media/<vid>/<path:filename>")
def api_media(vid, filename):
    task_dir = _resolve_task_dir(vid)
    if task_dir is None:
        return jsonify({"error": "unsafe task path"}), 400
    # The cover is retained beside video.mp4 so IdeaHub can copy both into its
    # independent sample archive. This endpoint is internal-token protected.
    allowed = {
        "mp4", "webm", "mkv", "mov", "mp3", "m4a", "wav", "aac",
        "jpg", "jpeg", "png", "webp", "gif", "avif",
    }
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if suffix not in allowed:
        return jsonify({"error": "unsupported media type"}), 400
    return send_from_directory(
        str(task_dir), filename,
        as_attachment=request.args.get("download") == "1",
        download_name=filename,
    )


@app.route("/api/download/<vid>")
def api_download(vid):
    return api_export(vid, "txt")


@app.route("/api/export/<vid>/<export_format>")
def api_export(vid, export_format):
    if export_format not in {"json", "md", "txt"}:
        return jsonify({"error": "unsupported export format"}), 400
    content_path = OUTPUT_DIR / vid / "content.json"
    if not content_path.exists():
        return jsonify({"error": "not found"}), 404
    try:
        content = json.loads(content_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return jsonify({"error": "invalid result file"}), 500

    stem = _safe_export_name(content.get("title"), vid)
    if export_format == "json":
        payload = json.dumps(content, ensure_ascii=False, indent=2).encode("utf-8")
        mime_type = "application/json; charset=utf-8"
    else:
        payload = _build_export_text(content, export_format).encode("utf-8")
        mime_type = "text/markdown; charset=utf-8" if export_format == "md" else "text/plain; charset=utf-8"
    return send_file(
        BytesIO(payload),
        mimetype=mime_type,
        as_attachment=True,
        download_name=f"{stem}.{export_format}",
    )


@app.route("/api/technical-audit/<vid>/<audit_format>")
def api_technical_audit(vid, audit_format):
    if not _is_local_request():
        return jsonify({"error": "技术审计仅允许在服务器本机下载"}), 403
    if audit_format not in {"json", "md"}:
        return jsonify({"error": "unsupported audit format"}), 400

    task_dir = _resolve_task_dir(vid)
    if task_dir is None:
        return jsonify({"error": "unsafe task path"}), 400
    audit_path = task_dir / f"ai_analysis.technical.{audit_format}"
    if not audit_path.is_file():
        return jsonify({"error": "该任务尚未生成技术审计文件"}), 404

    mime_type = "application/json; charset=utf-8" if audit_format == "json" else "text/markdown; charset=utf-8"
    return send_file(
        audit_path,
        mimetype=mime_type,
        as_attachment=True,
        download_name=f"{vid}.ai-analysis-technical.{audit_format}",
    )


@app.route("/api/ideahub/status")
def api_ideahub_status():
    return jsonify({
        "configured": bool(IDEAHUB_API_KEY and IDEAHUB_INGEST_URL),
        "documentation_url": IDEAHUB_DOC_URL,
        "channels": {
            channel: destination
            for channel, destination in IDEAHUB_CHANNELS.items()
            if "," not in channel
        },
    })


class IdeaHubPushError(Exception):
    def __init__(self, message, status_code):
        super().__init__(message)
        self.status_code = status_code


def _push_task_to_ideahub(vid, channel):
    """Send one task's saved JSON bytes and return a browser-safe summary."""
    task_dir = _resolve_task_dir(vid)
    if task_dir is None:
        raise IdeaHubPushError("invalid task id", 400)
    content_path = task_dir / "content.json"
    if not content_path.is_file():
        raise IdeaHubPushError("当前任务没有可推送的完整 JSON", 404)

    payload = content_path.read_bytes()
    if len(payload) > IDEAHUB_MAX_PAYLOAD_BYTES:
        raise IdeaHubPushError("JSON 超过 IdeaHub 分析接口的 8MB 请求上限", 413)

    try:
        upstream = _post_ideahub_analysis(payload, channel)
    except httpx.RequestError as exc:
        raise IdeaHubPushError(f"无法连接 IdeaHub：{exc.__class__.__name__}", 502) from exc
    except RuntimeError as exc:
        raise IdeaHubPushError(str(exc), 502) from exc

    safe_results = []
    for item in upstream.get("results") or []:
        if not isinstance(item, dict):
            continue
        safe_results.append({
            key: item[key]
            for key in ("channel", "board", "id", "created", "accountId", "tagsApplied")
            if key in item
        })
    return {
        "ok": True,
        "channel": channel,
        "destination": IDEAHUB_CHANNELS[channel],
        "taskId": upstream.get("taskId"),
        "sourceRef": upstream.get("sourceRef"),
        "title": upstream.get("title"),
        "results": safe_results,
    }


@app.route("/api/ideahub/push/<vid>", methods=["POST"])
def api_ideahub_push(vid):
    body = request.get_json(silent=True) or {}
    channel = str(body.get("channel") or "").strip()
    if channel not in IDEAHUB_CHANNELS:
        return jsonify({"error": "channel 必须显式填写 persona、matrix 或 persona,matrix"}), 400
    if not IDEAHUB_API_KEY:
        return jsonify({"error": "IdeaHub 密钥尚未配置，请由技术人员设置 IDEAHUB_API_KEY"}), 503
    try:
        return jsonify(_push_task_to_ideahub(vid, channel))
    except IdeaHubPushError as exc:
        return jsonify({"error": str(exc)}), exc.status_code


@app.route("/api/ideahub/archive-sample/<vid>", methods=["POST"])
def api_ideahub_archive_sample(vid):
    if not IDEAHUB_API_KEY:
        return jsonify({"error": "IdeaHub 样本归档密钥尚未配置"}), 503
    task = db.get_task(vid)
    task_dir = _resolve_task_dir(vid)
    if not task or task.get("status") != "done" or task_dir is None:
        return jsonify({"error": "只有已完成任务可以归档样本"}), 409
    content_path = task_dir / "content.json"
    try:
        content = json.loads(content_path.read_text(encoding="utf-8"))
        archived = _post_ideahub_sample(content)
        content["sample_archive"] = {
            "status": "done",
            "sample_id": archived.get("sampleId") or archived.get("id"),
            "capture_id": archived.get("captureId"),
        }
        _atomic_write_text(
            content_path, json.dumps(content, ensure_ascii=False, indent=2)
        )
        return jsonify({"ok": True, **content["sample_archive"]})
    except Exception as exc:
        return jsonify({
            "error": public_error_message(exc, fallback="归档样本失败")
        }), 502


@app.route("/api/ideahub/push-batch", methods=["POST"])
def api_ideahub_push_batch():
    body = request.get_json(silent=True) or {}
    channel = str(body.get("channel") or "").strip()
    if channel not in IDEAHUB_CHANNELS:
        return jsonify({"error": "channel 必须显式填写 persona、matrix 或 persona,matrix"}), 400
    if not IDEAHUB_API_KEY:
        return jsonify({"error": "IdeaHub 密钥尚未配置，请由技术人员设置 IDEAHUB_API_KEY"}), 503

    raw_task_ids = body.get("task_ids")
    if not isinstance(raw_task_ids, list):
        return jsonify({"error": "task_ids 必须是作品 ID 数组"}), 400
    task_ids = list(dict.fromkeys(str(item).strip() for item in raw_task_ids if str(item).strip()))
    if not task_ids:
        return jsonify({"error": "请至少选择 1 条作品"}), 400
    if len(task_ids) > 50:
        return jsonify({"error": "单次最多推送 50 条作品"}), 400

    items = []
    for vid in task_ids:
        try:
            result = _push_task_to_ideahub(vid, channel)
            items.append({"task_id": vid, **result})
        except IdeaHubPushError as exc:
            items.append({"task_id": vid, "ok": False, "error": str(exc)})

    succeeded = sum(1 for item in items if item["ok"])
    return jsonify({
        "ok": succeeded == len(items),
        "partial": 0 < succeeded < len(items),
        "channel": channel,
        "destination": IDEAHUB_CHANNELS[channel],
        "total": len(items),
        "succeeded": succeeded,
        "failed": len(items) - succeeded,
        "items": items,
    })


@app.route("/api/history")
def api_history():
    tasks = db.list_tasks(50)
    for task in tasks:
        active = _running.get(task["id"]) or {}
        if active.get("manual_refresh") and active.get("status") in {"pending", "running"}:
            task["refresh_status"] = active["status"]
            task["refresh_progress"] = active.get("progress", 0)
            task["refresh_message"] = active.get("message", "正在更新最新数据")
    return jsonify(tasks)


class TaskDeleteError(Exception):
    def __init__(self, message, status_code):
        super().__init__(message)
        self.status_code = status_code


def _prepare_task_deletion(vid):
    task_dir = _resolve_task_dir(vid)
    if task_dir is None:
        raise TaskDeleteError("invalid task id", 400)
    if not db.get_task(vid):
        raise TaskDeleteError("任务不存在或已被删除", 404)
    if _running.get(vid, {}).get("status") in {"pending", "running"}:
        raise TaskDeleteError("所选作品中有任务正在采集或更新，请完成后再删除", 409)
    return task_dir


def _delete_tasks_atomically(task_ids):
    """Preflight all tasks, then move files aside and delete DB rows together."""
    prepared = [(vid, _prepare_task_deletion(vid)) for vid in task_ids]
    file_counts = {
        vid: sum(1 for path in task_dir.rglob("*") if path.is_file()) if task_dir.exists() else 0
        for vid, task_dir in prepared
    }
    stage_dir = (OUTPUT_DIR / f".delete-batch-{uuid.uuid4().hex}").resolve()
    if stage_dir.parent != OUTPUT_DIR.resolve():
        raise TaskDeleteError("unsafe delete staging path", 500)

    moved = []
    try:
        stage_dir.mkdir(parents=True)
        for vid, task_dir in prepared:
            if task_dir.exists():
                staged_task_dir = stage_dir / vid
                task_dir.replace(staged_task_dir)
                moved.append((task_dir, staged_task_dir))
        deleted_count = db.delete_tasks(task_ids)
        if deleted_count != len(task_ids):
            raise RuntimeError("数据库删除数量不一致")
    except Exception:
        for task_dir, staged_task_dir in reversed(moved):
            if staged_task_dir.exists() and not task_dir.exists():
                staged_task_dir.replace(task_dir)
        shutil.rmtree(stage_dir, ignore_errors=True)
        raise

    shutil.rmtree(stage_dir, ignore_errors=True)
    for vid in task_ids:
        _running.pop(vid, None)
    return [
        {"task_id": vid, "deleted_files": file_counts[vid]}
        for vid in task_ids
    ]


@app.route("/api/task/<vid>", methods=["DELETE"])
def api_delete_task(vid):
    try:
        item = _delete_tasks_atomically([vid])[0]
    except TaskDeleteError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    except Exception as exc:
        app.logger.error(
            "Task deletion failed for %s (%s)", vid, exc.__class__.__name__
        )
        return jsonify({"error": "删除失败，原历史结果已保留"}), 500
    return jsonify({"deleted": True, **item})


@app.route("/api/tasks/batch-delete", methods=["POST"])
def api_batch_delete_tasks():
    body = request.get_json(silent=True) or {}
    raw_task_ids = body.get("task_ids")
    if not isinstance(raw_task_ids, list):
        return jsonify({"error": "task_ids 必须是作品 ID 数组"}), 400
    task_ids = list(dict.fromkeys(str(item).strip() for item in raw_task_ids if str(item).strip()))
    if not task_ids:
        return jsonify({"error": "请至少选择 1 条历史结果"}), 400
    if len(task_ids) > 50:
        return jsonify({"error": "单次最多删除 50 条历史结果"}), 400
    try:
        items = _delete_tasks_atomically(task_ids)
    except TaskDeleteError as exc:
        return jsonify({"error": str(exc)}), exc.status_code
    except Exception as exc:
        app.logger.error("Batch task deletion failed (%s)", exc.__class__.__name__)
        return jsonify({"error": "批量删除失败，原历史结果已保留"}), 500
    return jsonify({"deleted": True, "deleted_count": len(items), "items": items})


if __name__ == "__main__":
    print("Starting server at http://127.0.0.1:5000")
    app.run(host="0.0.0.0", port=5000, debug=False)
