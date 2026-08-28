import socket
import unittest

from security import (
    UnsafeUrl,
    fetch_safe_text,
    install_playwright_request_guard,
    redact_sensitive_text,
    safe_egress_proxy,
    validate_public_url,
    valid_internal_token,
)


def public_dns(_host, port, type=socket.SOCK_STREAM):
    return [(socket.AF_INET, type, 6, "", ("8.8.8.8", port))]


def private_dns(_host, port, type=socket.SOCK_STREAM):
    return [(socket.AF_INET, type, 6, "", ("127.0.0.1", port))]


class SecurityUnitTests(unittest.TestCase):
    def test_url_token_and_redaction_boundaries(self):
        valid = "https://www.xiaohongshu.com/explore/abc"
        self.assertEqual(valid, validate_public_url(valid, resolver=public_dns))
        for item in (
            "http://www.xiaohongshu.com/explore/abc",
            "https://user:pass@www.xiaohongshu.com/explore/abc",
            "https://www.xiaohongshu.com:8443/explore/abc",
            "https://evil.example/a",
        ):
            with self.subTest(item=item), self.assertRaises(UnsafeUrl):
                validate_public_url(item, resolver=public_dns)
        with self.assertRaises(UnsafeUrl):
            validate_public_url(valid, resolver=private_dns)

        token = "collector-test-token-at-least-32-bytes"
        self.assertTrue(valid_internal_token(token, token))
        self.assertFalse(valid_internal_token("short", "short"))
        safe = redact_sensitive_text(
            "GET https://xhslink.com/a?xsec_token=secret "
            "Authorization: Bearer abcdefghijklmnop C:\\collector\\cookie.txt"
        )
        for secret in ("xsec_token", "secret", "abcdefghijklmnop", "C:\\collector"):
            self.assertNotIn(secret, safe)

    def test_connect_proxy_rejects_private_dns_before_connecting(self):
        with safe_egress_proxy(resolver=private_dns) as proxy_url:
            port = int(proxy_url.rsplit(":", 1)[1])
            with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
                client.sendall(
                    b"CONNECT www.xiaohongshu.com:443 HTTP/1.1\r\n"
                    b"Host: www.xiaohongshu.com:443\r\n\r\n"
                )
                response = client.recv(512)
        self.assertIn(b"403", response.split(b"\r\n", 1)[0])


class AsyncSecurityUnitTests(unittest.IsolatedAsyncioTestCase):
    async def test_private_redirect_is_blocked_before_second_request(self):
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
                client_factory=Client,
                resolver=dns,
            )
        self.assertEqual(1, len(calls))

    async def test_cross_origin_redirect_strips_cookie_header(self):
        calls = []

        class Response:
            def __init__(self, status, url, headers, body=b""):
                self.status_code, self.url, self.headers = status, url, headers
                self.encoding, self._body = "utf-8", body
            def raise_for_status(self): return None
            async def aiter_bytes(self):
                yield self._body

        responses = [
            Response(302, "https://www.xiaohongshu.com/a", {
                "location": "https://www.douyin.com/video/123"
            }),
            Response(200, "https://www.douyin.com/video/123", {}, b"ok"),
        ]

        class Stream:
            def __init__(self, response): self.response = response
            async def __aenter__(self): return self.response
            async def __aexit__(self, *_args): return False

        class Client:
            def __init__(self, **_kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *_args): return False
            def stream(self, _method, url, **kwargs):
                calls.append((url, dict(kwargs.get("headers") or {})))
                return Stream(responses.pop(0))

        text, _headers, final_url = await fetch_safe_text(
            "https://www.xiaohongshu.com/a",
            headers={"Cookie": "web_session=secret", "User-Agent": "test"},
            client_factory=Client,
            resolver=public_dns,
        )
        self.assertEqual("ok", text)
        self.assertEqual("https://www.douyin.com/video/123", final_url)
        self.assertIn("Cookie", calls[0][1])
        self.assertNotIn("Cookie", calls[1][1])

    async def test_playwright_guard_allows_data_and_blocks_non_https(self):
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

        for url, expected in (
            ("data:text/plain,ok", "continue"),
            ("blob:https://www.xiaohongshu.com/id", "continue"),
            ("http://www.xiaohongshu.com/a", "abort"),
        ):
            route = Route(url)
            await handlers[0](route)
            self.assertEqual(expected, route.action)


if __name__ == "__main__":
    unittest.main()
