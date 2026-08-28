import unittest
import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as app_module

from media.comment_extractor import (
    BrowserCommentCollector,
    HotCommentPool,
    _normalize_douyin,
    _normalize_xhs,
    _is_fuzzy_like,
    _estimate_top5_confidence,
    _netscape_cookies,
)
from media.platform_login import (
    _extract_xhs_public_profile,
    _is_xhs_authenticated,
    _save_netscape_cookies,
    friendly_xhs_login_error,
)


class HotCommentPoolTests(unittest.TestCase):
    def test_fuzzy_xhs_like_count_is_detected(self):
        self.assertTrue(_is_fuzzy_like("10+"))
        self.assertFalse(_is_fuzzy_like("334"))

    def test_strict_threshold_dedup_and_top_five(self):
        pool = HotCommentPool(threshold=20, limit=5, max_scanned=20)
        for index, likes in enumerate([20, 21, 50, 30, 90, 70, 40, 100]):
            pool.add({"id": str(index), "text": f"c{index}", "like_count": likes, "type": "comment"})
        pool.add({"id": "7", "text": "duplicate", "like_count": 999, "type": "comment"})

        self.assertEqual([100, 90, 70, 50, 40], [item["like_count"] for item in pool.result()])
        self.assertEqual(8, pool.scanned)

    def test_replies_are_counted_in_same_candidate_pool(self):
        pool = HotCommentPool(threshold=20, limit=2, max_scanned=10)
        pool.add({"id": "parent", "text": "parent", "like_count": 30, "type": "comment"})
        pool.add({"id": "reply", "text": "reply", "like_count": 80, "type": "reply"})

        self.assertEqual(["reply", "parent"], [item["id"] for item in pool.result()])
        self.assertEqual(1, pool.replies_scanned)

    def test_confidence_reaches_target_after_stable_deep_sample(self):
        pool = HotCommentPool(threshold=20, limit=5, max_scanned=200)
        for index in range(100):
            pool.add({
                "id": str(index),
                "text": f"comment-{index}",
                "like_count": 300 - index,
                "type": "reply" if index >= 50 else "comment",
            })
        collector = BrowserCommentCollector("xiaohongshu", pool)
        collector.primary_pages = 4
        collector.stable_pages = 3
        collector.recent_primary_max_likes = [80, 60, 40]

        self.assertGreaterEqual(_estimate_top5_confidence(pool, collector, 20), 0.80)

    def test_confidence_stays_low_without_five_candidates(self):
        pool = HotCommentPool(threshold=20, limit=5, max_scanned=200)
        pool.add({"id": "one", "text": "only", "like_count": 30, "type": "comment"})
        collector = BrowserCommentCollector("xiaohongshu", pool)
        collector.primary_pages = 5
        collector.stable_pages = 5

        self.assertLess(_estimate_top5_confidence(pool, collector, 20), 0.80)


class ResultPreservationTests(unittest.TestCase):
    def test_failed_refresh_preserves_last_good_comments(self):
        from app import _preserve_last_good_comments

        last_good = {
            "comments": [{"id": "best", "like_count": 334}],
            "comment_summary": {"status": "ok", "returned": 1, "confidence": 0.86},
        }
        failed = {
            "comments": [],
            "comment_summary": {"status": "unavailable", "scanned": 0},
        }
        result = _preserve_last_good_comments(failed, last_good)

        self.assertEqual("best", result["comments"][0]["id"])
        self.assertTrue(result["comment_summary"]["preserved_previous"])
        self.assertEqual("unavailable", result["comment_summary"]["last_refresh_status"])


class PlatformNormalizationTests(unittest.TestCase):
    def test_douyin_reply_fields(self):
        item = _normalize_douyin({
            "cid": "r1",
            "text": "回复内容",
            "digg_count": 45,
            "create_time": 1700000000,
            "user": {"nickname": "甲", "avatar_thumb": {"url_list": ["https://img/a"]}},
            "reply_to_user": {"nickname": "乙"},
        }, parent_id="p1", force_reply=True)

        self.assertEqual("reply", item["type"])
        self.assertEqual("p1", item["parent_comment_id"])
        self.assertEqual("乙", item["reply_to_author"])
        self.assertEqual(45, item["like_count"])

    def test_xhs_comment_fields(self):
        item = _normalize_xhs({
            "id": "x1",
            "content": "一级评论",
            "like_count": "28",
            "user_info": {"nickname": "用户", "image": "https://img/x"},
            "sub_comment_count": "3",
        })

        self.assertEqual("comment", item["type"])
        self.assertEqual(28, item["like_count"])
        self.assertEqual(3, item["reply_count"])

    def test_inline_replies_are_consumed_without_persistence(self):
        pool = HotCommentPool(threshold=20, limit=5, max_scanned=20)
        collector = BrowserCommentCollector("douyin", pool)
        collector._consume({
            "has_more": 1,
            "comments": [{
                "cid": "p",
                "text": "parent",
                "digg_count": 25,
                "reply_comment": [{"cid": "r", "text": "reply", "digg_count": 60}],
            }],
        }, is_reply=False, parent_id="")

        results = pool.result()
        self.assertEqual(["r", "p"], [item["id"] for item in results])
        self.assertEqual("reply", results[0]["type"])
        self.assertEqual("parent", results[0]["parent_excerpt"])
        self.assertEqual(2, pool.scanned)

    def test_duplicate_cursor_response_is_ignored(self):
        pool = HotCommentPool(threshold=20, limit=5, max_scanned=20)
        collector = BrowserCommentCollector("xiaohongshu", pool)
        page = {"has_more": True, "comments": [{"id": "x", "content": "same", "like_count": "50"}]}
        collector._consume(page, is_reply=False, parent_id="", cursor="cursor-1")
        collector._consume(page, is_reply=False, parent_id="", cursor="cursor-1")

        self.assertEqual(1, collector.primary_pages)
        self.assertEqual(1, pool.scanned)


class LoginCookieTests(unittest.TestCase):
    def test_public_profile_is_whitelisted_from_nested_selfinfo(self):
        profile = _extract_xhs_public_profile({
            "data": {
                "result": {"success": True},
                "user": {
                    "nickname": "当前账号",
                    "red_id": "red-2026",
                    "user_id": "user-1",
                    "desc": "公开简介",
                    "web_session": "must-not-leak",
                },
            },
        })

        self.assertEqual("当前账号", profile["nickname"])
        self.assertEqual("red-2026", profile["red_id"])
        self.assertEqual("https://www.xiaohongshu.com/user/profile/user-1", profile["profile_url"])
        self.assertNotIn("web_session", profile)

    def test_closed_verification_window_has_business_friendly_message(self):
        message = friendly_xhs_login_error(
            "Page.wait_for_timeout: Target page, context or browser has been closed",
            saved=True,
        )

        self.assertEqual("验证窗口已关闭，已保留原登录状态", message)

    def test_login_status_includes_current_public_account(self):
        account = {"nickname": "当前账号", "red_id": "red-2026"}
        with (
            patch.object(app_module, "_login_state", {"status": "saved", "message": ""}),
            patch.object(app_module, "has_saved_xhs_login", return_value=True),
            patch.object(app_module, "read_xhs_login_profile", return_value=account),
        ):
            response = app_module.app.test_client().get("/api/login/xiaohongshu/status")

        self.assertEqual(200, response.status_code)
        self.assertEqual(account, response.get_json()["account"])

    def test_account_sync_endpoint_returns_current_public_account(self):
        account = {"nickname": "当前账号", "red_id": "red-2026"}
        with (
            patch.object(app_module, "_login_state", {"status": "saved", "message": ""}),
            patch.object(app_module, "has_saved_xhs_login", return_value=True),
            patch.object(app_module, "sync_saved_xhs_account", return_value=account),
            patch.object(app_module, "read_xhs_login_profile", return_value=account),
        ):
            response = app_module.app.test_client().post("/api/login/xiaohongshu/account")

        self.assertEqual(200, response.status_code)
        self.assertEqual(account, response.get_json()["account"])

    def test_switch_account_api_starts_a_fresh_login_context(self):
        state = {"status": "saved", "message": ""}
        with (
            patch.object(app_module, "_login_state", state),
            patch.object(app_module.threading, "Thread") as thread,
        ):
            response = app_module.app.test_client().post(
                "/api/login/xiaohongshu",
                json={"force_fresh": True},
            )

        self.assertEqual(200, response.status_code)
        self.assertIn("账号切换", response.get_json()["message"])
        self.assertIs(app_module._run_xhs_login, thread.call_args.kwargs["target"])
        self.assertEqual((True,), thread.call_args.kwargs["args"])
        thread.return_value.start.assert_called_once_with()

    def test_guest_web_session_is_not_treated_as_login(self):
        class VisibleLocator:
            async def count(self): return 1
            def nth(self, _index): return self
            async def is_visible(self): return True

        class FakeContext:
            async def cookies(self):
                return [{"name": "web_session", "value": "guest-session-value"}]

        class GuestPage:
            context = FakeContext()
            async def evaluate(self, _script):
                return {"data": {"result": {"success": False}}}
            def locator(self, _selector): return VisibleLocator()
            def get_by_text(self, _pattern): return VisibleLocator()

        self.assertFalse(asyncio.run(_is_xhs_authenticated(GuestPage())))

    def test_selfinfo_success_is_treated_as_login(self):
        class UserPage:
            async def evaluate(self, _script):
                return {"data": {"result": {"success": True}}}

        self.assertTrue(asyncio.run(_is_xhs_authenticated(UserPage())))

    def test_hidden_login_controls_with_session_are_authenticated(self):
        class HiddenLocator:
            async def count(self): return 1
            def nth(self, _index): return self
            async def is_visible(self): return False

        class FakeContext:
            async def cookies(self):
                return [{"name": "web_session", "value": "authenticated-session-value"}]

        class AuthenticatedPage:
            context = FakeContext()
            async def evaluate(self, _script):
                return {"success": False}
            def locator(self, _selector): return HiddenLocator()
            def get_by_text(self, _pattern): return HiddenLocator()

        self.assertTrue(asyncio.run(_is_xhs_authenticated(AuthenticatedPage())))

    def test_saved_login_cookie_round_trip(self):
        with TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "xiaohongshu.cookies.txt"
            _save_netscape_cookies([{
                "name": "web_session",
                "value": "session-value",
                "domain": ".xiaohongshu.com",
                "path": "/",
                "secure": True,
                "httpOnly": True,
                "expires": 1900000000,
            }], path)

            loaded = _netscape_cookies(path)
            self.assertEqual("web_session", loaded[0]["name"])
            self.assertEqual("session-value", loaded[0]["value"])
            self.assertTrue(loaded[0]["httpOnly"])

    def test_reply_button_scan_tolerates_navigation_context_loss(self):
        from media.comment_extractor import _click_reply_threads

        class BrokenLocator:
            async def count(self):
                raise RuntimeError("Execution context was destroyed")

        class NavigatingPage:
            def get_by_text(self, _pattern):
                return BrokenLocator()

        self.assertEqual(0, asyncio.run(_click_reply_threads(NavigatingPage(), 10)))


if __name__ == "__main__":
    unittest.main()
