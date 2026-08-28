"""Interactive platform login helpers.

Xiaohongshu login is completed by the user in a visible Chromium window. The
resulting browser cookies are stored locally in Netscape format so the existing
download and comment collectors can reuse them without exposing cookie values
through the web API.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Callable

from playwright.async_api import async_playwright
from security import install_playwright_request_guard

from .comment_extractor import (
    STORAGE_STATE_FILES,
    _has_visible_login_prompt,
    _netscape_cookies,
    _save_netscape_cookies,
)
from .profile_extractor import extract_account_from_html
from config import DATA_DIR, COLLECTOR_QR_TTL_SEC

XHS_COOKIE_FILE = DATA_DIR / "xiaohongshu.cookies.txt"
XHS_LOGIN_MARKER = DATA_DIR / "xiaohongshu.cookies.txt.validated"
XHS_LOGIN_URL = "https://www.xiaohongshu.com/explore"
XHS_STORAGE_STATE_FILE = STORAGE_STATE_FILES["xiaohongshu"]
XHS_LOGIN_PROFILE_FILE = DATA_DIR / "xiaohongshu.login_profile.json"
XHS_QR_FILE = DATA_DIR / "xiaohongshu.login_qr.png"

XHS_PUBLIC_PROFILE_FIELDS = (
    "nickname",
    "red_id",
    "user_id",
    "profile_url",
    "avatar_url",
    "description",
    "updated_at",
)


def has_saved_xhs_login() -> bool:
    return (
        XHS_COOKIE_FILE.is_file()
        and XHS_COOKIE_FILE.stat().st_size > 80
        and XHS_LOGIN_MARKER.is_file()
    )


def invalidate_xhs_login() -> None:
    """Mark the saved session unvalidated after the API obscures like counts."""
    XHS_LOGIN_MARKER.unlink(missing_ok=True)
    XHS_LOGIN_PROFILE_FILE.unlink(missing_ok=True)


def _public_scalar(mapping, *keys: str) -> str:
    if not isinstance(mapping, dict):
        return ""
    for key in keys:
        value = mapping.get(key)
        if value is None or isinstance(value, (dict, list, tuple, set, bool)):
            continue
        return str(value).strip()
    return ""


def _iter_mappings(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _iter_mappings(child)
    elif isinstance(value, list):
        for child in value:
            yield from _iter_mappings(child)


def _extract_xhs_public_profile(payload) -> dict[str, str]:
    """Whitelist a public account summary from the signed selfinfo response."""
    candidates = []
    for item in _iter_mappings(payload):
        nickname = _public_scalar(item, "nickname", "nickName", "name")
        red_id = _public_scalar(item, "red_id", "redId", "red_id_v2", "xhsId")
        user_id = _public_scalar(item, "user_id", "userId", "userid")
        avatar_url = _public_scalar(item, "imageb", "images", "avatar", "avatar_url")
        description = _public_scalar(item, "desc", "description", "bio")
        score = (5 if nickname else 0) + (3 if red_id else 0) + (3 if user_id else 0)
        if score:
            candidates.append((score, nickname, red_id, user_id, avatar_url, description))
    if not candidates:
        return {}
    _, nickname, red_id, user_id, avatar_url, description = max(candidates, key=lambda item: item[0])
    if not nickname:
        return {}
    return {
        "nickname": nickname,
        "red_id": red_id,
        "user_id": user_id,
        "profile_url": f"https://www.xiaohongshu.com/user/profile/{user_id}" if user_id else "",
        "avatar_url": avatar_url if avatar_url.startswith(("http://", "https://")) else "",
        "description": description,
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
    }


def read_xhs_login_profile() -> dict[str, str]:
    """Read only the whitelisted public fields saved for the active login."""
    if not has_saved_xhs_login() or not XHS_LOGIN_PROFILE_FILE.is_file():
        return {}
    try:
        value = json.loads(XHS_LOGIN_PROFILE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(value, dict):
        return {}
    return {
        field: str(value.get(field) or "").strip()
        for field in XHS_PUBLIC_PROFILE_FIELDS
    }


def _save_xhs_login_profile(profile: dict[str, str]) -> None:
    if not profile.get("nickname"):
        return
    safe_profile = {
        field: str(profile.get(field) or "").strip()
        for field in XHS_PUBLIC_PROFILE_FIELDS
    }
    temp_path = XHS_LOGIN_PROFILE_FILE.with_suffix(XHS_LOGIN_PROFILE_FILE.suffix + ".tmp")
    temp_path.write_text(json.dumps(safe_profile, ensure_ascii=False, indent=2), encoding="utf-8")
    temp_path.replace(XHS_LOGIN_PROFILE_FILE)


def persist_xhs_login_session(
    cookies: list[dict], storage_state: dict, profile: dict[str, str]
) -> None:
    """Publish a verified session while the caller holds its generation lock."""
    _save_netscape_cookies(cookies, XHS_COOKIE_FILE)
    temp_state = XHS_STORAGE_STATE_FILE.with_suffix(
        XHS_STORAGE_STATE_FILE.suffix + ".tmp"
    )
    temp_state.write_text(
        json.dumps(storage_state, ensure_ascii=False), encoding="utf-8"
    )
    temp_state.replace(XHS_STORAGE_STATE_FILE)
    XHS_LOGIN_MARKER.write_text("validated\n", encoding="utf-8")
    if profile:
        _save_xhs_login_profile(profile)


def friendly_xhs_login_error(error, *, saved: bool = False) -> str:
    message = str(error or "")
    lowered = message.casefold()
    if "target page, context or browser has been closed" in lowered or "登录窗口已关闭" in message:
        return "验证窗口已关闭，已保留原登录状态" if saved else "验证窗口已关闭，尚未完成登录"
    if "timeout" in lowered or "超时" in message:
        return "账号验证超时，请重新发起验证"
    if "账号资料" in message or "登录态" in message:
        return message
    return "小红书账号验证未完成，请重新尝试"


async def _request_xhs_selfinfo(page):
    return await page.evaluate("""async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        try {
            const response = await fetch('/api/sns/web/v1/user/selfinfo', {
                method: 'GET',
                credentials: 'include',
                headers: {'Accept': 'application/json'},
                signal: controller.signal
            });
            return await response.json();
        } finally {
            clearTimeout(timer);
        }
    }""")


def _selfinfo_succeeded(payload) -> bool:
    return any(item.get("success") is True for item in _iter_mappings(payload))


async def _is_xhs_authenticated(page) -> bool:
    """Validate login using signed selfinfo when available, then visible UI state."""
    try:
        if _selfinfo_succeeded(await _request_xhs_selfinfo(page)):
            return True
    except Exception:
        pass

    # A raw fetch can be rejected when it bypasses XHS's signing interceptor.
    # The page itself is authoritative: guest sessions retain a visible login
    # button or comments-login overlay after the modal closes.
    try:
        cookies = await page.context.cookies()
        has_session = any(
            cookie.get("name") == "web_session" and len(str(cookie.get("value") or "")) > 10
            for cookie in cookies
        )
        return has_session and not await _has_visible_login_prompt(page)
    except Exception:
        return False


async def _profile_from_page(page) -> dict[str, str]:
    try:
        profile = _extract_xhs_public_profile(await _request_xhs_selfinfo(page))
        if profile:
            return profile
    except Exception:
        pass

    try:
        state = await page.evaluate("() => window.__INITIAL_STATE__ || null")
        profile = _extract_xhs_public_profile(state)
        if profile:
            return profile
    except Exception:
        pass

    profile_url = ""
    for selector in (
        'a.link-wrapper[href*="/user/profile/"]',
        'a.bottom-channel[href*="/user/profile/"]',
    ):
        try:
            target = page.locator(selector).first
            if await target.count():
                profile_url = str(await target.get_attribute("href") or "").split("?", 1)[0]
                if re.fullmatch(r"https://www\.xiaohongshu\.com/user/profile/[A-Za-z0-9_-]+", profile_url):
                    break
                profile_url = ""
        except Exception:
            continue
    if not profile_url:
        return {}

    try:
        await page.goto(profile_url, wait_until="domcontentloaded", timeout=30_000)
        await page.wait_for_timeout(1_800)
        state = await page.evaluate("() => window.__INITIAL_STATE__ || null")
        profile = _extract_xhs_public_profile(state)
        if profile:
            return profile
        account = extract_account_from_html(await page.content(), "xiaohongshu")
        user_id_match = re.search(r"/user/profile/([A-Za-z0-9_-]+)", profile_url)
        user_id = user_id_match.group(1) if user_id_match else ""
        if account.get("name"):
            return {
                "nickname": account.get("name") or "",
                "red_id": "",
                "user_id": user_id,
                "profile_url": profile_url,
                "avatar_url": "",
                "description": account.get("bio") or "",
                "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            }
    except Exception:
        pass
    return {}


async def sync_saved_xhs_account() -> dict[str, str]:
    """Validate the saved session headlessly and refresh its public account summary."""
    if not has_saved_xhs_login():
        raise RuntimeError("当前没有可验证的小红书登录态")
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            context_options = {
                "viewport": {"width": 1180, "height": 820},
                "locale": "zh-CN",
                "service_workers": "block",
                "user_agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"),
            }
            if XHS_STORAGE_STATE_FILE.exists():
                context_options["storage_state"] = str(XHS_STORAGE_STATE_FILE)
            context = await browser.new_context(**context_options)
            if "storage_state" not in context_options:
                cookies = _netscape_cookies(XHS_COOKIE_FILE)
                if cookies:
                    await context.add_cookies(cookies)
            page = await context.new_page()
            await install_playwright_request_guard(page)
            await page.goto(XHS_LOGIN_URL, wait_until="domcontentloaded", timeout=30_000)
            await page.wait_for_timeout(2_000)
            if not await _is_xhs_authenticated(page):
                raise RuntimeError("保存的小红书登录态已失效，请重新验证")
            profile = await _profile_from_page(page)
            if not profile:
                raise RuntimeError("已确认登录，但平台暂未返回账号资料")
            _save_xhs_login_profile(profile)
            return profile
        finally:
            await browser.close()


async def login_xiaohongshu(
    progress: Callable[..., None], *, timeout_sec: int = COLLECTOR_QR_TTL_SEC,
    force_fresh: bool = False,
    is_current: Callable[[], bool] | None = None,
    publish_qr: Callable[[Path], bool] | None = None,
    commit_session: Callable[[list[dict], dict, dict[str, str]], bool] | None = None,
    cleanup_qr: Callable[[], None] | None = None,
    qr_file: Path = XHS_QR_FILE,
) -> None:
    """Run headless QR login and persist authenticated cookies server-side.

    ``force_fresh`` deliberately starts with an empty browser context so a user
    can switch accounts. Existing credentials stay on disk until the new login
    succeeds, which makes closing or timing out the window non-destructive.
    """
    is_current = is_current or (lambda: True)

    def default_publish(temp_path: Path) -> bool:
        temp_path.replace(qr_file)
        return True

    def default_commit(cookies: list[dict], state: dict, profile: dict[str, str]) -> bool:
        persist_xhs_login_session(cookies, state, profile)
        return True

    publish_qr = publish_qr or default_publish
    commit_session = commit_session or default_commit
    cleanup_qr = cleanup_qr or (lambda: qr_file.unlink(missing_ok=True))
    qr_temp_file: Path | None = None
    opening_message = "正在打开小红书账号切换窗口…" if force_fresh else "正在打开小红书登录窗口…"
    progress("opening", opening_message)
    if not is_current():
        return
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=True,
            args=["--disable-dev-shm-usage", "--no-sandbox"],
        )
        try:
            context_options = {
                "viewport": {"width": 1180, "height": 820},
                "locale": "zh-CN",
                "service_workers": "block",
                "user_agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"),
            }
            if XHS_STORAGE_STATE_FILE.exists() and not force_fresh:
                context_options["storage_state"] = str(XHS_STORAGE_STATE_FILE)
            context = await browser.new_context(**context_options)
            saved_cookies = [] if force_fresh else _netscape_cookies(XHS_COOKIE_FILE)
            if saved_cookies and not context_options.get("storage_state"):
                await context.add_cookies(saved_cookies)
            page = await context.new_page()
            await install_playwright_request_guard(page)
            await page.goto(XHS_LOGIN_URL, wait_until="domcontentloaded", timeout=30_000)
            # The SPA renders its guest login controls after DOMContentLoaded.
            # Checking earlier creates a false positive while the shell is blank.
            await page.wait_for_timeout(3_000)
            # If the saved session is still valid, no scan is required.
            if not await _is_xhs_authenticated(page):
                login_buttons = page.get_by_text(re.compile(r"^登录$"))
                for index in range(await login_buttons.count() - 1, -1, -1):
                    try:
                        target = login_buttons.nth(index)
                        if await target.is_visible():
                            await target.click(timeout=2_000)
                            break
                    except Exception:
                        continue
                await page.wait_for_timeout(800)
                qr = None
                for selector in (
                    ".login-container canvas",
                    ".login-container img",
                    "[class*='qrcode'] canvas",
                    "[class*='qrcode'] img",
                    "[class*='qr-code'] canvas",
                    "[class*='qr-code'] img",
                ):
                    try:
                        candidate = page.locator(selector).first
                        if await candidate.count() and await candidate.is_visible():
                            box = await candidate.bounding_box()
                            if box and box["width"] >= 100 and box["height"] >= 100:
                                qr = candidate
                                break
                    except Exception:
                        continue
                if qr is None:
                    raise RuntimeError("平台登录页未找到二维码，请稍后重试")
                if not is_current():
                    return
                qr_file.parent.mkdir(parents=True, exist_ok=True)
                qr_temp_file = qr_file.with_name(
                    f"{qr_file.name}.{time.time_ns()}.tmp"
                )
                await qr.screenshot(path=str(qr_temp_file), type="png")
                if not is_current() or not publish_qr(qr_temp_file):
                    return
                qr_temp_file = None
                progress(
                    "waiting_scan",
                    "请使用小红书手机端扫码登录",
                    qr_available=True,
                    expires_at=int(time.time()) + timeout_sec,
                )
            deadline = time.monotonic() + timeout_sec
            authenticated_rounds = 0
            while time.monotonic() < deadline:
                if not is_current():
                    return
                if page.is_closed():
                    raise RuntimeError("登录窗口已关闭，未检测到登录成功")
                if await _is_xhs_authenticated(page):
                    authenticated_rounds += 1
                    if authenticated_rounds >= 3:
                        profile = await _profile_from_page(page)
                        cookies = await context.cookies()
                        storage_state = await context.storage_state()
                        if not is_current() or not commit_session(
                            cookies, storage_state, profile
                        ):
                            return
                        progress("done", "小红书登录成功，登录态已保存")
                        if not page.is_closed():
                            try:
                                await page.wait_for_timeout(800)
                            except Exception:
                                pass
                        return
                else:
                    authenticated_rounds = 0
                await page.wait_for_timeout(500)
            raise TimeoutError("扫码登录超时，请重新发起登录")
        finally:
            if qr_temp_file is not None:
                qr_temp_file.unlink(missing_ok=True)
            cleanup_qr()
            await browser.close()
