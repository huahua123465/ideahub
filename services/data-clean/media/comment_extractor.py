"""Bounded hot-comment extraction for Douyin and Xiaohongshu.

The browser observes the platforms' own comment API responses while scrolling and
opening popular reply threads. Raw pages are never persisted: only the best K
comments/replies above the configured like threshold are returned.
"""
from __future__ import annotations

import asyncio
import heapq
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from playwright.async_api import Page, Response, async_playwright
from security import install_playwright_request_guard, public_error_message

from config import (
    DATA_DIR,
    COMMENT_LIKE_THRESHOLD,
    COMMENT_MIN_CONFIDENCE_SCANNED,
    COMMENT_MAX_PRIMARY_PAGES,
    COMMENT_MAX_REPLY_PAGES,
    COMMENT_MAX_REPLY_THREADS,
    COMMENT_MAX_SCANNED,
    COMMENT_TIMEOUT_SEC,
    COMMENT_TARGET_CONFIDENCE,
    COMMENT_TOP_K,
)


COOKIE_FILES = {
    "douyin": DATA_DIR / "douyin.cookies.txt",
    "xiaohongshu": DATA_DIR / "xiaohongshu.cookies.txt",
}
STORAGE_STATE_FILES = {
    "xiaohongshu": DATA_DIR / "xiaohongshu.storage_state.json",
}
API_MARKERS = {
    "douyin": ("/aweme/v1/web/comment/list/", "/aweme/v1/web/comment/list/reply/"),
    "xiaohongshu": ("/api/sns/web/v2/comment/page", "/api/sns/web/v2/comment/sub/page"),
}


def _as_int(value: Any) -> int:
    try:
        if isinstance(value, str):
            value = value.replace(",", "").strip()
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _is_fuzzy_like(value: Any) -> bool:
    return isinstance(value, str) and bool(re.search(r"\d\s*\+$", value.strip()))


def _first_url(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return next((item for item in value if isinstance(item, str)), "")
    if isinstance(value, dict):
        return _first_url(value.get("url_list") or value.get("url_default") or value.get("url"))
    return ""


def _nickname(user: Any) -> str:
    if not isinstance(user, dict):
        return ""
    return str(user.get("nickname") or user.get("nick_name") or user.get("name") or "")


@dataclass
class HotCommentPool:
    threshold: int = COMMENT_LIKE_THRESHOLD
    limit: int = COMMENT_TOP_K
    max_scanned: int = COMMENT_MAX_SCANNED
    heap: list[tuple[int, int, dict]] = field(default_factory=list)
    seen: set[str] = field(default_factory=set)
    scanned: int = 0
    replies_scanned: int = 0
    _sequence: int = 0

    @property
    def full(self) -> bool:
        return self.scanned >= self.max_scanned

    def add(self, item: dict) -> None:
        if self.full:
            return
        comment_id = str(item.get("id") or "")
        if not comment_id or comment_id in self.seen:
            return
        self.seen.add(comment_id)
        self.scanned += 1
        if item.get("type") == "reply":
            self.replies_scanned += 1

        likes = _as_int(item.get("like_count"))
        if likes <= self.threshold or not str(item.get("text") or "").strip():
            return
        item["like_count"] = likes
        self._sequence += 1
        entry = (likes, self._sequence, item)
        if len(self.heap) < self.limit:
            heapq.heappush(self.heap, entry)
        elif entry[:2] > self.heap[0][:2]:
            heapq.heapreplace(self.heap, entry)

    def result(self) -> list[dict]:
        return [entry[2] for entry in sorted(self.heap, reverse=True)]

    @property
    def candidate_count(self) -> int:
        return len(self.heap)

    @property
    def kth_likes(self) -> int:
        return self.heap[0][0] if len(self.heap) >= self.limit else 0

    @property
    def signature(self) -> tuple[str, ...]:
        return tuple(str(item.get("id") or "") for item in self.result())


def _normalize_douyin(raw: dict, *, parent_id: str = "", force_reply: bool = False) -> dict:
    user = raw.get("user") or {}
    reply_to = raw.get("reply_to_user") or raw.get("reply_to_reply_user") or {}
    inferred_parent = parent_id or str(raw.get("reply_id") or "")
    is_reply = force_reply or (inferred_parent not in ("", "0"))
    return {
        "id": str(raw.get("cid") or raw.get("id") or ""),
        "type": "reply" if is_reply else "comment",
        "author": _nickname(user),
        "avatar_url": _first_url(user.get("avatar_thumb") or user.get("avatar_medium") or user.get("avatar")),
        "text": str(raw.get("text") or raw.get("content") or "").strip(),
        "like_count": _as_int(raw.get("digg_count") or raw.get("like_count")),
        "created_at": _as_int(raw.get("create_time")),
        "reply_count": _as_int(raw.get("reply_comment_total") or raw.get("reply_count")),
        "parent_comment_id": inferred_parent if is_reply else "",
        "reply_to_author": _nickname(reply_to),
    }


def _normalize_xhs(raw: dict, *, parent_id: str = "", force_reply: bool = False) -> dict:
    user = raw.get("user_info") or raw.get("user") or {}
    reply_to = raw.get("target_comment") or raw.get("reply_to_comment") or {}
    reply_user = reply_to.get("user_info") or reply_to.get("user") or raw.get("target_user") or {}
    inferred_parent = parent_id or str(raw.get("root_comment_id") or raw.get("parent_comment_id") or "")
    is_reply = force_reply or bool(inferred_parent)
    return {
        "id": str(raw.get("id") or raw.get("comment_id") or ""),
        "type": "reply" if is_reply else "comment",
        "author": _nickname(user),
        "avatar_url": _first_url(user.get("image") or user.get("avatar") or user.get("avatar_url")),
        "text": str(raw.get("content") or raw.get("text") or "").strip(),
        "like_count": _as_int(raw.get("like_count") or raw.get("liked_count")),
        "created_at": _as_int(raw.get("create_time") or raw.get("create_time_ms")),
        "reply_count": _as_int(raw.get("sub_comment_count") or raw.get("reply_count")),
        "parent_comment_id": inferred_parent if is_reply else "",
        "reply_to_author": _nickname(reply_user),
    }


def _netscape_cookies(path: Path) -> list[dict]:
    """Convert a Netscape cookie file into Playwright cookie dictionaries."""
    if not path.exists():
        return []
    cookies = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        http_only = line.startswith("#HttpOnly_")
        if http_only:
            line = line[len("#HttpOnly_"):]
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) != 7:
            continue
        domain, _include_subdomains, cookie_path, secure, expires, name, value = parts
        cookie = {
            "name": name,
            "value": value,
            "domain": domain,
            "path": cookie_path or "/",
            "secure": secure.upper() == "TRUE",
            "httpOnly": http_only,
        }
        expiry = _as_int(expires)
        if expiry > 0:
            cookie["expires"] = expiry
        cookies.append(cookie)
    return cookies


def _save_netscape_cookies(cookies: list[dict], path: Path) -> None:
    """Atomically persist browser cookies, including server-side rotations."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Netscape HTTP Cookie File", "# Saved by the local content collector."]
    for cookie in cookies:
        domain = str(cookie.get("domain") or "")
        if not domain or not cookie.get("name"):
            continue
        include_subdomains = "TRUE" if domain.startswith(".") else "FALSE"
        secure = "TRUE" if cookie.get("secure") else "FALSE"
        expires = int(cookie.get("expires") or 0)
        domain_field = f"#HttpOnly_{domain}" if cookie.get("httpOnly") else domain
        lines.append("\t".join([
            domain_field,
            include_subdomains,
            str(cookie.get("path") or "/"),
            secure,
            str(expires),
            str(cookie["name"]),
            str(cookie.get("value") or ""),
        ]))
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    temp_path.replace(path)


async def _has_visible_login_prompt(page) -> bool:
    """Return true only when the page visibly presents a login control."""
    for selector in (".login-btn", ".comments-login", ".login-container"):
        try:
            locator = page.locator(selector)
            for index in range(min(await locator.count(), 5)):
                if await locator.nth(index).is_visible():
                    return True
        except Exception:
            continue
    try:
        exact_login = page.get_by_text(re.compile(r"^登录$"))
        for index in range(min(await exact_login.count(), 8)):
            if await exact_login.nth(index).is_visible():
                return True
    except Exception:
        pass
    return False


async def _xhs_session_evidence(page) -> str:
    """Classify strong browser evidence without treating limited data as logout.

    A fuzzy like count or an empty comment stream is not authentication proof.
    Only a visible login prompt combined with the absence of a web session is
    strong enough to invalidate the persisted login marker.
    """
    try:
        cookies = await page.context.cookies()
        has_session = any(
            cookie.get("name") == "web_session"
            and len(str(cookie.get("value") or "")) > 10
            for cookie in cookies
        )
    except Exception:
        return "unknown"
    visible_prompt = await _has_visible_login_prompt(page)
    if visible_prompt and not has_session:
        return "guest"
    if has_session and not visible_prompt:
        return "authenticated"
    return "unknown"


def _comment_collection_status(observer, comments: list[dict], session_evidence: str) -> str:
    if observer.fuzzy_like_count and not comments:
        return "login_required" if session_evidence == "guest" else "limited"
    return "ok" if observer.primary_pages or observer.pool.scanned else "unavailable"


class BrowserCommentCollector:
    def __init__(self, platform: str, pool: HotCommentPool):
        self.platform = platform
        self.pool = pool
        self.primary_pages = 0
        self.reply_pages: dict[str, int] = {}
        self.has_more = True
        self.errors: list[str] = []
        self.fuzzy_like_count = 0
        self.parent_context: dict[str, dict[str, str]] = {}
        self.seen_pages: set[tuple[str, str, str]] = set()
        self.response_pages = 0
        self.stable_pages = 0
        self._last_signature: tuple[str, ...] = ()
        self.recent_primary_max_likes: list[int] = []
        self._lock = asyncio.Lock()

    async def observe(self, response: Response) -> None:
        primary_marker, reply_marker = API_MARKERS[self.platform]
        is_reply = reply_marker in response.url
        if not is_reply and primary_marker not in response.url:
            return
        try:
            payload = await response.json()
            if not isinstance(payload, dict):
                return
            data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
            query = parse_qs(urlparse(response.url).query)
            parent_id = next(iter(query.get("comment_id") or query.get("root_comment_id") or [""]), "")
            cursor = next(iter(query.get("cursor") or [""]), "")
            async with self._lock:
                self._consume(data, is_reply=is_reply, parent_id=parent_id, cursor=cursor)
        except Exception as exc:
            if len(self.errors) < 3:
                self.errors.append(str(exc))

    def _consume(self, data: dict, *, is_reply: bool, parent_id: str, cursor: str = "") -> None:
        page_key = ("reply" if is_reply else "primary", parent_id, cursor)
        if page_key in self.seen_pages:
            return
        self.seen_pages.add(page_key)
        if is_reply:
            self.reply_pages[parent_id] = self.reply_pages.get(parent_id, 0) + 1
            if self.reply_pages[parent_id] > COMMENT_MAX_REPLY_PAGES:
                return
        else:
            self.primary_pages += 1
            if self.primary_pages > COMMENT_MAX_PRIMARY_PAGES:
                return
            self.has_more = bool(data.get("has_more", False))

        comments = data.get("comments") or data.get("comment_list") or []
        if not isinstance(comments, list):
            return
        normalizer = _normalize_douyin if self.platform == "douyin" else _normalize_xhs
        page_max_likes = 0
        for raw in comments:
            if self.pool.full or not isinstance(raw, dict):
                break
            like_value = raw.get("digg_count") if self.platform == "douyin" else raw.get("like_count")
            if _is_fuzzy_like(like_value):
                self.fuzzy_like_count += 1
            normalized = normalizer(raw, parent_id=parent_id, force_reply=is_reply)
            page_max_likes = max(page_max_likes, normalized["like_count"])
            if not is_reply and normalized["id"]:
                self.parent_context[normalized["id"]] = {
                    "author": normalized["author"],
                    "text": normalized["text"][:160],
                }
            elif is_reply and parent_id in self.parent_context:
                normalized["parent_excerpt"] = self.parent_context[parent_id]["text"]
            self.pool.add(normalized)
            raw_id = normalized["id"]
            inline = (
                raw.get("reply_comment")
                or raw.get("sub_comments")
                or raw.get("sub_comment_list")
                or []
            )
            if isinstance(inline, dict):
                inline = inline.get("comments") or inline.get("items") or []
            if isinstance(inline, list):
                for reply in inline:
                    if self.pool.full or not isinstance(reply, dict):
                        break
                    reply_like = reply.get("digg_count") if self.platform == "douyin" else reply.get("like_count")
                    if _is_fuzzy_like(reply_like):
                        self.fuzzy_like_count += 1
                    inline_item = normalizer(reply, parent_id=raw_id or parent_id, force_reply=True)
                    page_max_likes = max(page_max_likes, inline_item["like_count"])
                    if raw_id in self.parent_context:
                        inline_item["parent_excerpt"] = self.parent_context[raw_id]["text"]
                    self.pool.add(inline_item)

        self.response_pages += 1
        signature = self.pool.signature
        if signature and signature == self._last_signature:
            self.stable_pages += 1
        else:
            self.stable_pages = 0
        self._last_signature = signature
        if not is_reply:
            self.recent_primary_max_likes.append(page_max_likes)
            self.recent_primary_max_likes = self.recent_primary_max_likes[-3:]


def _estimate_top5_confidence(
    pool: HotCommentPool, observer: BrowserCommentCollector, reply_threads_clicked: int
) -> float:
    """Heuristic probability that the bounded sample contains the global Top 5.

    Xiaohongshu exposes cursor pagination but no public global-like sort. This
    score therefore combines hot-stream depth, sample size, Top-5 stability,
    late-page dominance and reply coverage. It is an estimate, not a proof.
    """
    if pool.candidate_count < pool.limit:
        return round(min(0.55, 0.10 + pool.scanned / max(COMMENT_MIN_CONFIDENCE_SCANNED, 1) * 0.35), 3)

    depth = min(observer.primary_pages / 5, 1.0) * 0.20
    sample = min(pool.scanned / max(COMMENT_MIN_CONFIDENCE_SCANNED, 1), 1.0) * 0.20
    stability = min(observer.stable_pages / 3, 1.0) * 0.25
    late_max = max(observer.recent_primary_max_likes[-2:] or [pool.kth_likes + 1])
    dominance = 0.15 if pool.kth_likes >= late_max else max(0.0, 0.15 * pool.kth_likes / max(late_max, 1))
    reply_coverage = min(max(pool.replies_scanned / 50, reply_threads_clicked / 20), 1.0) * 0.10
    return round(min(0.97, 0.10 + depth + sample + stability + dominance + reply_coverage), 3)


async def _click_reply_threads(page: Page, max_threads: int) -> int:
    """Expand a bounded number of visible reply threads using text semantics."""
    patterns = [
        re.compile(r"(?:展开|查看|展开查看).{0,8}(?:条)?回复"),
        re.compile(r"更多回复"),
    ]
    clicked = 0
    for pattern in patterns:
        locator = page.get_by_text(pattern)
        try:
            count = min(await locator.count(), max_threads - clicked)
        except Exception:
            # Xiaohongshu may replace the execution context once after restoring
            # a saved login session. The next collection round can safely retry.
            return clicked
        for index in range(count):
            try:
                target = locator.nth(index)
                if await target.is_visible():
                    await target.click(timeout=1500)
                    clicked += 1
                    await page.wait_for_timeout(250)
            except Exception:
                continue
        if clicked >= max_threads:
            break
    return clicked


async def extract_hot_comments(
    url: str, platform: str, *, use_login: bool = True,
) -> dict:
    """Return bounded high-like comments and coverage metadata.

    Failures are intentionally contained so comment extraction never fails the
    surrounding post/video pipeline.
    """
    base_summary = {
        "threshold": COMMENT_LIKE_THRESHOLD,
        "limit": COMMENT_TOP_K,
        "returned": 0,
        "scanned": 0,
        "replies_scanned": 0,
        "primary_pages": 0,
        "reply_pages": 0,
        "scope": "bounded_platform_hot_stream",
        "truncated": False,
        "status": "unavailable",
        "likes_obscured": False,
        "obscured_count": 0,
        "confidence": 0.0,
        "confidence_target": COMMENT_TARGET_CONFIDENCE,
        "strategy": "adaptive_hot_stream",
    }
    if platform not in API_MARKERS:
        return {"comments": [], "comment_summary": {**base_summary, "status": "unsupported"}}

    pool = HotCommentPool()
    observer = BrowserCommentCollector(platform, pool)
    browser = None
    session_evidence = "not_applicable" if use_login else "public_mode"
    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            context_options = {
                "viewport": {"width": 1365, "height": 900},
                "locale": "zh-CN",
                "user_agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"),
                "service_workers": "block",
            }
            storage_state_path = STORAGE_STATE_FILES.get(platform) if use_login else None
            if storage_state_path and storage_state_path.exists():
                context_options["storage_state"] = str(storage_state_path)
            context = await browser.new_context(**context_options)
            cookies = _netscape_cookies(COOKIE_FILES[platform]) if use_login else []
            if cookies and not context_options.get("storage_state"):
                await context.add_cookies(cookies)
            page = await context.new_page()
            await install_playwright_request_guard(page)
            page.on("response", observer.observe)
            await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            # Let the SPA restore the authenticated session and mount its
            # comment panel before driving the hot stream.
            await page.wait_for_timeout(1_800)
            if platform == "xiaohongshu" and use_login:
                session_evidence = await _xhs_session_evidence(page)

            deadline = asyncio.get_running_loop().time() + COMMENT_TIMEOUT_SEC
            reply_threads_clicked = 0
            stagnant_rounds = 0
            previous_scanned = -1
            while asyncio.get_running_loop().time() < deadline and not pool.full:
                if observer.primary_pages >= COMMENT_MAX_PRIMARY_PAGES:
                    break
                try:
                    if reply_threads_clicked < COMMENT_MAX_REPLY_THREADS:
                        reply_threads_clicked += await _click_reply_threads(
                            page, COMMENT_MAX_REPLY_THREADS - reply_threads_clicked
                        )
                    await page.mouse.wheel(0, 1400)
                    await page.wait_for_timeout(700)
                    if reply_threads_clicked < COMMENT_MAX_REPLY_THREADS:
                        reply_threads_clicked += await _click_reply_threads(
                            page, COMMENT_MAX_REPLY_THREADS - reply_threads_clicked
                        )
                    await page.mouse.wheel(0, 900)
                    await page.wait_for_timeout(450)
                except Exception as exc:
                    # Session restoration can trigger a client-side redirect.
                    # Treat it as a transient round instead of losing the whole
                    # comment result.
                    if len(observer.errors) < 3:
                        observer.errors.append(str(exc))
                    await page.wait_for_timeout(700)
                    continue

                if pool.scanned == previous_scanned:
                    stagnant_rounds += 1
                else:
                    stagnant_rounds = 0
                previous_scanned = pool.scanned
                confidence = _estimate_top5_confidence(pool, observer, reply_threads_clicked)
                if (
                    confidence >= COMMENT_TARGET_CONFIDENCE
                    and pool.scanned >= COMMENT_MIN_CONFIDENCE_SCANNED
                    and observer.primary_pages >= 3
                    and observer.stable_pages >= 2
                ):
                    break
                if stagnant_rounds >= (8 if not observer.primary_pages else 6):
                    break
                if observer.primary_pages and not observer.has_more and observer.stable_pages >= 2:
                    break

            # Give already-triggered reply responses a short chance to settle.
            await page.wait_for_timeout(500)
            refreshed_cookies = await context.cookies()
            if refreshed_cookies and cookies:
                _save_netscape_cookies(refreshed_cookies, COOKIE_FILES[platform])
            if storage_state_path:
                temp_state = storage_state_path.with_suffix(storage_state_path.suffix + ".tmp")
                await context.storage_state(path=str(temp_state))
                temp_state.replace(storage_state_path)
            await context.close()

        comments = pool.result()
        confidence = _estimate_top5_confidence(pool, observer, reply_threads_clicked)
        reply_page_count = sum(min(count, COMMENT_MAX_REPLY_PAGES) for count in observer.reply_pages.values())
        truncated = bool(
            pool.full
            or observer.primary_pages >= COMMENT_MAX_PRIMARY_PAGES
            or reply_threads_clicked >= COMMENT_MAX_REPLY_THREADS
            or any(count >= COMMENT_MAX_REPLY_PAGES for count in observer.reply_pages.values())
            or observer.has_more
        )
        status = _comment_collection_status(observer, comments, session_evidence)
        summary = {
            **base_summary,
            "returned": len(comments),
            "scanned": pool.scanned,
            "replies_scanned": pool.replies_scanned,
            "primary_pages": observer.primary_pages,
            "reply_pages": reply_page_count,
            "scope": "bounded_platform_hot_stream",
            "truncated": truncated,
            "status": status,
            "session_evidence": session_evidence,
            "likes_obscured": bool(observer.fuzzy_like_count),
            "obscured_count": observer.fuzzy_like_count,
            "confidence": confidence,
            "confidence_target": COMMENT_TARGET_CONFIDENCE,
            "confidence_reached": confidence >= COMMENT_TARGET_CONFIDENCE,
            "stable_pages": observer.stable_pages,
        }
        return {"comments": comments, "comment_summary": summary}
    except Exception as exc:
        if browser:
            try:
                await browser.close()
            except Exception:
                pass
        return {
            "comments": pool.result(),
            "comment_summary": {
                **base_summary,
                "returned": len(pool.heap),
                "scanned": pool.scanned,
                "replies_scanned": pool.replies_scanned,
                "primary_pages": observer.primary_pages,
                "reply_pages": sum(observer.reply_pages.values()),
                "truncated": True,
                "session_evidence": session_evidence,
                "status": "partial" if pool.scanned else "unavailable",
                "likes_obscured": bool(observer.fuzzy_like_count),
                "obscured_count": observer.fuzzy_like_count,
                "confidence": _estimate_top5_confidence(pool, observer, 0),
                "confidence_target": COMMENT_TARGET_CONFIDENCE,
                "confidence_reached": False,
                "message": public_error_message(
                    exc, fallback="评论采集暂时不可用，请稍后重试"
                ),
            },
        }
