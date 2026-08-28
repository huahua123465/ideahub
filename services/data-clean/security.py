"""Collector trust-boundary helpers.

Only IdeaHub may call this service.  URL validation is deliberately strict:
collection inputs must be HTTPS links for supported platforms and every DNS
answer must be globally routable.  Redirects are followed one hop at a time so
each target is validated before it is requested.
"""
from __future__ import annotations

import hmac
import ipaddress
import re
import select
import socket
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx


INPUT_HOST_SUFFIXES = (
    "xiaohongshu.com",
    "xhslink.com",
    "xhslink.cn",
    "douyin.com",
)
MEDIA_HOST_SUFFIXES = INPUT_HOST_SUFFIXES + (
    "xhscdn.com",
    "xhscdn.net",
    "douyinvod.com",
    "byteimg.com",
    "bytecdn.cn",
    "snssdk.com",
)
REDIRECT_CODES = {301, 302, 303, 307, 308}
_URL_PATTERN = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
_SECRET_PATTERNS = (
    re.compile(r"(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)((?:cookie|set-cookie|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)[^\s,;]+"),
)
_WINDOWS_PATH = re.compile(r"(?i)(?<![A-Za-z0-9])(?:[A-Z]:\\|\\\\)[^\r\n\"']+")
_POSIX_PATH = re.compile(r"(?<![:A-Za-z0-9])/(?:[^/\s]+/)+[^\s,;:\"']+")


class UnsafeUrl(ValueError):
    pass


def _public_addresses(host: str, port: int, resolver=socket.getaddrinfo) -> list[str]:
    try:
        addresses = {
            item[4][0]
            for item in resolver(host, port, type=socket.SOCK_STREAM)
            if item and len(item) > 4 and item[4]
        }
    except OSError as exc:
        raise UnsafeUrl("链接域名无法解析") from exc
    if not addresses or any(not _is_public_ip(address) for address in addresses):
        raise UnsafeUrl("链接解析到了非公网地址")
    return sorted(addresses)


def _host_allowed(host: str, suffixes: tuple[str, ...]) -> bool:
    host = host.rstrip(".").casefold()
    return any(host == suffix or host.endswith("." + suffix) for suffix in suffixes)


def _is_public_ip(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    # is_global rejects private, loopback, link-local, multicast, reserved,
    # documentation ranges and cloud-metadata addresses for IPv4 and IPv6.
    return address.is_global


def redact_url(value: str) -> str:
    """Return a URL that is safe for ordinary logs and user-visible state."""
    try:
        parsed = urlsplit(str(value or ""))
    except ValueError:
        return "[invalid-url]"
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.netloc:
        return "[invalid-url]"
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def redact_sensitive_text(value, *, max_length: int = 240) -> str:
    """Remove credentials, URL queries and absolute paths from a short string."""
    text = str(value or "")
    text = _URL_PATTERN.sub(lambda match: redact_url(match.group(0)), text)
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub(lambda match: f"{match.group(1)}[redacted]", text)
    text = _WINDOWS_PATH.sub("[local-path]", text)
    text = _POSIX_PATH.sub("[local-path]", text)
    text = re.sub(r"[\r\n\t]+", " ", text).strip()
    return text[:max(0, int(max_length))]


def public_error_message(error, *, fallback: str = "处理失败，请稍后重试") -> str:
    """Map failures to a bounded public message without returning raw exceptions."""
    if isinstance(error, UnsafeUrl):
        return redact_sensitive_text(error)
    if isinstance(error, (TimeoutError, httpx.TimeoutException)):
        return "处理超时，请稍后重试"
    if isinstance(error, ValueError):
        message = redact_sensitive_text(error)
        if any(marker in message for marker in ("限制", "过大", "过长", "无法验证")):
            return message
    return fallback


def validate_public_https_url(value: str, *, resolver=None) -> str:
    """Validate a generic HTTPS URL whose DNS answers are all public."""
    if not isinstance(value, str) or not value.strip():
        raise UnsafeUrl("缺少链接")
    value = value.strip()
    parsed = urlsplit(value)
    if parsed.scheme.casefold() != "https":
        raise UnsafeUrl("只允许 HTTPS 链接")
    if parsed.username is not None or parsed.password is not None:
        raise UnsafeUrl("链接不能包含用户信息")
    try:
        port = parsed.port
    except ValueError as exc:
        raise UnsafeUrl("端口格式无效") from exc
    if port not in (None, 443):
        raise UnsafeUrl("只允许标准 HTTPS 端口")
    host = (parsed.hostname or "").rstrip(".").casefold()
    if not host or host == "metadata.google.internal":
        raise UnsafeUrl("禁止访问非公网地址")
    resolver = resolver or socket.getaddrinfo
    _public_addresses(host, 443, resolver)
    return value


class _SafeConnectProxy(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, handler, resolver):
        self.resolver = resolver
        super().__init__(address, handler)


class _SafeConnectHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args):
        return

    def do_CONNECT(self):
        upstream = None
        try:
            parsed = urlsplit(f"https://{self.path}")
            if not parsed.hostname or parsed.port != 443:
                raise UnsafeUrl("代理只允许 HTTPS 443")
            addresses = _public_addresses(parsed.hostname, 443, self.server.resolver)
            last_error = None
            for address in addresses:
                try:
                    family = socket.AF_INET6 if ":" in address else socket.AF_INET
                    upstream = socket.socket(family, socket.SOCK_STREAM)
                    upstream.settimeout(15)
                    target = (address, 443, 0, 0) if family == socket.AF_INET6 else (address, 443)
                    upstream.connect(target)
                    break
                except OSError as exc:
                    last_error = exc
                    if upstream:
                        upstream.close()
                    upstream = None
            if upstream is None:
                raise UnsafeUrl("公网媒体连接失败") from last_error
            self.send_response(200, "Connection Established")
            self.end_headers()
            sockets = [self.connection, upstream]
            while True:
                readable, _, exceptional = select.select(sockets, [], sockets, 30)
                if exceptional or not readable:
                    break
                for source in readable:
                    data = source.recv(64 * 1024)
                    if not data:
                        return
                    target = upstream if source is self.connection else self.connection
                    target.sendall(data)
        except (UnsafeUrl, OSError, ValueError):
            if not self.wfile.closed:
                self.send_error(403, "Forbidden")
        finally:
            if upstream:
                upstream.close()

    def do_GET(self):
        self.send_error(403, "HTTPS required")


@contextmanager
def safe_egress_proxy(*, resolver=socket.getaddrinfo):
    """Temporary localhost CONNECT proxy that pins validated public IPs."""
    server = _SafeConnectProxy(("127.0.0.1", 0), _SafeConnectHandler, resolver)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def validate_public_url(
    value: str,
    *,
    media: bool = False,
    resolver=None,
) -> str:
    """Validate an HTTPS platform URL and all current DNS answers."""
    value = validate_public_https_url(value, resolver=resolver)
    parsed = urlsplit(value)
    resolver = resolver or socket.getaddrinfo
    host = (parsed.hostname or "").rstrip(".").casefold()
    suffixes = MEDIA_HOST_SUFFIXES if media else INPUT_HOST_SUFFIXES
    if not host or not _host_allowed(host, suffixes):
        raise UnsafeUrl("仅支持小红书和抖音链接")
    return value


def validate_browser_request_url(value: str, *, resolver=None) -> str:
    """Allow local data/blob resources; require public HTTPS for all network I/O."""
    scheme = urlsplit(str(value or "")).scheme.casefold()
    if scheme in {"data", "blob"}:
        return value
    return validate_public_https_url(value, resolver=resolver)


async def install_playwright_request_guard(page, *, resolver=None) -> None:
    """Install the shared context-wide outbound guard before a page navigates."""
    async def guard(route):
        try:
            validate_browser_request_url(route.request.url, resolver=resolver)
        except (UnsafeUrl, ValueError):
            await route.abort("blockedbyclient")
            return
        await route.continue_()

    context = getattr(page, "context", None)
    target = context if context is not None else page
    await target.route("**/*", guard)
    # Playwright 1.48+ can block WebSockets explicitly. Older supported
    # versions still get the HTTPS-only HTTP guard; the residual limitation is
    # documented for VPS network-policy hardening.
    route_web_socket = getattr(target, "route_web_socket", None)
    if route_web_socket is not None:
        async def block_web_socket(web_socket):
            await web_socket.close()

        await route_web_socket("**/*", block_web_socket)


def resolve_safe_redirects(
    value: str,
    *,
    timeout: float = 15.0,
    max_redirects: int = 5,
    client_factory=httpx.Client,
    resolver=None,
) -> str:
    """Resolve a supported share URL while validating every redirect hop."""
    resolver = resolver or socket.getaddrinfo
    current = validate_public_url(value, resolver=resolver)
    with client_factory(
        follow_redirects=False,
        timeout=timeout,
        headers={"User-Agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/125 Safari/537.36"},
    ) as client:
        for _ in range(max_redirects + 1):
            response = client.get(current)
            if response.status_code not in REDIRECT_CODES:
                response.raise_for_status()
                final = str(getattr(response, "url", current) or current)
                return validate_public_url(final, resolver=resolver)
            location = response.headers.get("location", "")
            if not location:
                raise UnsafeUrl("平台返回了无效跳转")
            current = validate_public_url(urljoin(current, location), resolver=resolver)
    raise UnsafeUrl("链接跳转次数过多")


def fetch_safe_bytes(
    value: str,
    *,
    media: bool = True,
    max_bytes: int,
    timeout: float = 20.0,
    headers: dict | None = None,
    max_redirects: int = 5,
    client_factory=httpx.Client,
    resolver=None,
):
    """Fetch bounded bytes while validating DNS and every redirect target."""
    resolver = resolver or socket.getaddrinfo
    current = validate_public_url(value, media=media, resolver=resolver)
    with client_factory(follow_redirects=False, timeout=timeout, headers=headers or {}) as client:
        for _ in range(max_redirects + 1):
            with client.stream("GET", current) as response:
                if response.status_code in REDIRECT_CODES:
                    location = response.headers.get("location", "")
                    if not location:
                        raise UnsafeUrl("媒体地址返回了无效跳转")
                    current = validate_public_url(
                        urljoin(current, location), media=media, resolver=resolver
                    )
                    continue
                response.raise_for_status()
                declared = int(response.headers.get("content-length") or 0)
                if declared > max_bytes:
                    raise UnsafeUrl("媒体文件超过大小限制")
                chunks = []
                size = 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise UnsafeUrl("媒体文件超过大小限制")
                    chunks.append(chunk)
                return b"".join(chunks), response.headers, current
    raise UnsafeUrl("媒体地址跳转次数过多")


async def fetch_safe_text(
    value: str,
    *,
    media: bool = False,
    max_bytes: int = 5 * 1024 * 1024,
    timeout: float = 20.0,
    headers: dict | None = None,
    max_redirects: int = 5,
    client_factory=httpx.AsyncClient,
    resolver=None,
):
    """Read bounded text while validating every redirect before requesting it."""
    resolver = resolver or socket.getaddrinfo
    current = validate_public_url(value, media=media, resolver=resolver)
    request_headers = dict(headers or {})
    async with client_factory(
        follow_redirects=False,
        timeout=timeout,
        http2=True,
    ) as client:
        for _ in range(max_redirects + 1):
            async with client.stream("GET", current, headers=request_headers) as response:
                if response.status_code in REDIRECT_CODES:
                    location = response.headers.get("location", "")
                    if not location:
                        raise UnsafeUrl("页面地址返回了无效跳转")
                    next_url = validate_public_url(
                        urljoin(current, location), media=media, resolver=resolver
                    )
                    if urlsplit(next_url).hostname != urlsplit(current).hostname:
                        request_headers = {
                            key: item for key, item in request_headers.items()
                            if key.casefold() not in {"cookie", "authorization", "proxy-authorization"}
                        }
                    current = next_url
                    continue
                if response.status_code >= 500:
                    response.raise_for_status()
                final = str(getattr(response, "url", current) or current)
                current = validate_public_url(final, media=media, resolver=resolver)
                declared = int(response.headers.get("content-length") or 0)
                if declared > max_bytes:
                    raise UnsafeUrl("页面响应超过大小限制")
                chunks = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise UnsafeUrl("页面响应超过大小限制")
                    chunks.append(chunk)
                content = b"".join(chunks)
                encoding = getattr(response, "encoding", None) or "utf-8"
                return content.decode(encoding, errors="replace"), response.headers, current
    raise UnsafeUrl("页面地址跳转次数过多")


def valid_internal_token(configured: str, supplied: str) -> bool:
    """Compare fixed trust tokens without leaking their matching prefix."""
    configured_bytes = (configured or "").encode("utf-8")
    supplied_bytes = (supplied or "").encode("utf-8")
    return len(configured_bytes) >= 32 and hmac.compare_digest(configured_bytes, supplied_bytes)
