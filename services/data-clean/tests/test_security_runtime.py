import socket
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as app_module
from db import TaskDB
from security import (
    UnsafeUrl, fetch_safe_text, install_playwright_request_guard,
    redact_sensitive_text, validate_public_url, valid_internal_token,
)


TOKEN = "collector-test-token-32-bytes-minimum-value"


def public_dns(_host, _port, type=socket.SOCK_STREAM):
    return [(socket.AF_INET, type, 6, "", ("8.8.8.8", 443))]


def private_dns(_host, _port, type=socket.SOCK_STREAM):
    return [(socket.AF_INET, type, 6, "", ("127.0.0.1", 443))]


class UrlBoundaryTests(unittest.TestCase):
    def test_supported_https_public_url_is_accepted(self):
        self.assertEqual(
            "https://www.xiaohongshu.com/explore/abc",
            validate_public_url(
                "https://www.xiaohongshu.com/explore/abc", resolver=public_dns
            ),
        )

    def test_rejects_scheme_userinfo_port_unknown_and_private_dns(self):
        invalid = [
            "http://www.xiaohongshu.com/explore/abc",
            "https://user:pass@www.xiaohongshu.com/explore/abc",
            "https://www.xiaohongshu.com:8443/explore/abc",
            "https://evil.example/explore/abc",
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(UnsafeUrl):
                validate_public_url(value, resolver=public_dns)
        with self.assertRaises(UnsafeUrl):
            validate_public_url(
                "https://www.douyin.com/video/1234567890", resolver=private_dns
            )

    def test_ipv6_link_local_and_metadata_are_rejected(self):
        def ipv6_dns(_host, _port, type=socket.SOCK_STREAM):
            return [(socket.AF_INET6, type, 6, "", ("fe80::1", 443, 0, 0))]

        with self.assertRaises(UnsafeUrl):
            validate_public_url("https://xhslink.com/a", resolver=ipv6_dns)

    def test_sensitive_text_removes_query_secret_and_local_path(self):
        value = ("GET https://www.xiaohongshu.com/a?xsec_token=secret "
                 "Authorization: Bearer abcdefghijklmnop C:\\collector\\state\\cookie.txt")
        safe = redact_sensitive_text(value)
        for secret in ("xsec_token", "secret", "abcdefghijklmnop", "C:\\collector"):
            self.assertNotIn(secret, safe)


class AsyncNetworkBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_private_redirect_is_stopped_before_second_request(self):
        calls = []
        def dns(host, port, type=socket.SOCK_STREAM):
            address = "127.0.0.1" if host == "www.douyin.com" else "8.8.8.8"
            return [(socket.AF_INET, type, 6, "", (address, port))]
        class Response:
            status_code = 302
            headers = {"location": "https://www.douyin.com/video/private"}
            url = "https://www.xiaohongshu.com/explore/a"
        class Stream:
            async def __aenter__(self): return Response()
            async def __aexit__(self, *_args): return False
        class Client:
            def __init__(self, **_kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *_args): return False
            def stream(self, _method, url, **_kwargs):
                calls.append(url)
                return Stream()
        with self.assertRaises(UnsafeUrl):
            await fetch_safe_text(
                "https://www.xiaohongshu.com/explore/a",
                client_factory=Client, resolver=dns,
            )
        self.assertEqual(1, len(calls))

    async def test_playwright_guard_allows_data_and_blocks_http(self):
        handlers = []
        class Context:
            async def route(self, _pattern, handler): handlers.append(handler)
        class Page:
            context = Context()
        await install_playwright_request_guard(Page(), resolver=public_dns)
        class Route:
            def __init__(self, url):
                self.request = type("Request", (), {"url": url})()
                self.action = ""
            async def continue_(self): self.action = "continue"
            async def abort(self, _reason): self.action = "abort"
        for url, expected in (("data:text/plain,ok", "continue"),
                              ("blob:https://www.xiaohongshu.com/id", "continue"),
                              ("http://www.xiaohongshu.com/a", "abort")):
            route = Route(url)
            await handlers[0](route)
            self.assertEqual(expected, route.action)


class AuthBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.old = dict(app_module.app.config)
        app_module.app.config.update(TESTING=False, COLLECTOR_AUTH_BYPASS_TESTS=False)

    def tearDown(self):
        app_module.app.config.clear()
        app_module.app.config.update(self.old)

    def test_token_comparison_requires_32_bytes(self):
        self.assertFalse(valid_internal_token("short", "short"))
        self.assertTrue(valid_internal_token(TOKEN, TOKEN))
        self.assertFalse(valid_internal_token(TOKEN, TOKEN + "x"))

    def test_health_is_public_but_all_other_routes_require_token(self):
        client = app_module.app.test_client()
        with patch.object(app_module, "COLLECTOR_INTERNAL_TOKEN", TOKEN):
            self.assertEqual(200, client.get("/health").status_code)
            self.assertEqual(401, client.get("/api/history").status_code)
            self.assertEqual(
                200,
                client.get(
                    "/api/history", headers={"X-Collector-Token": TOKEN}
                ).status_code,
            )

    def test_unconfigured_token_refuses_protected_service(self):
        with patch.object(app_module, "COLLECTOR_INTERNAL_TOKEN", ""):
            response = app_module.app.test_client().get("/api/history")
        self.assertEqual(503, response.status_code)
        self.assertNotIn("token", response.get_data(as_text=True).casefold())


class RecoveryAndQrTests(unittest.TestCase):
    def test_task_identity_is_scoped_per_ideahub_user(self):
        url = "https://www.xiaohongshu.com/explore/0123456789abcdef"
        first = app_module._owner_task_id(url, "11")
        self.assertEqual(first, app_module._owner_task_id(url, "11"))
        self.assertNotEqual(first, app_module._owner_task_id(url, "22"))

    def test_restart_marks_pending_and_running_interrupted(self):
        with TemporaryDirectory() as root:
            database = TaskDB(Path(root) / "pipeline.db")
            database.create_task("pending", "https://www.douyin.com/video/1")
            database.create_task("running", "https://www.douyin.com/video/2")
            database.update_status("running", "running")
            changed = database.recover_interrupted_tasks()
            self.assertEqual(2, changed)
            self.assertEqual("interrupted", database.get_task("pending")["status"])
            self.assertEqual("interrupted", database.get_task("running")["status"])

    def test_qr_is_no_store_and_expired_file_is_removed(self):
        with TemporaryDirectory() as root:
            qr = Path(root) / "qr.png"
            qr.write_bytes(b"not-a-real-png")
            state = {
                "status": "waiting_scan",
                "message": "scan",
                "qr_available": True,
                "expires_at": int(time.time()) - 1,
            }
            app_module.app.config.update(TESTING=True, COLLECTOR_AUTH_BYPASS_TESTS=True)
            with (
                patch.object(app_module, "XHS_QR_FILE", qr),
                patch.object(app_module, "_login_state", state),
            ):
                response = app_module.app.test_client().get(
                    "/api/login/xiaohongshu/qr"
                )
            self.assertEqual(410, response.status_code)
            self.assertIn("no-store", response.headers["Cache-Control"])
            self.assertEqual("nosniff", response.headers["X-Content-Type-Options"])
            self.assertFalse(qr.exists())

    def test_stale_login_generation_cannot_publish_any_shared_state(self):
        with TemporaryDirectory() as root:
            qr = Path(root) / "qr.png"
            stale = Path(root) / "stale.tmp"
            stale.write_bytes(b"stale")
            state = {"status": "opening", "message": "new", "qr_available": False}
            with (
                patch.object(app_module, "XHS_QR_FILE", qr),
                patch.object(app_module, "_login_state", state),
                patch.object(app_module, "_login_generation", 2),
                patch.object(app_module, "persist_xhs_login_session") as persist,
            ):
                self.assertFalse(app_module._update_login_generation(1, "done", "old"))
                self.assertFalse(app_module._publish_login_qr(1, stale))
                self.assertFalse(app_module._commit_login_session(1, [], {}, {}))
            self.assertEqual("opening", state["status"])
            self.assertFalse(qr.exists())
            self.assertTrue(stale.exists())
            persist.assert_not_called()


if __name__ == "__main__":
    unittest.main()
