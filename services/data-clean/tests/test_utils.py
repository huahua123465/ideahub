import unittest
from unittest.mock import patch

from utils import (
    canonical_content_key,
    detect_platform,
    normalize_url,
    resolve_share_url,
    url_to_id,
)


NOTE_ID = "6a6e0eb80000000005031f6f"


class _Response:
    status_code = 200
    url = (
        f"https://www.xiaohongshu.com/discovery/item/{NOTE_ID}"
        "?app_platform=ios&xsec_source=app_share&xsec_token=token"
    )

    def raise_for_status(self):
        return None


class _Client:
    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def get(self, _url):
        return _Response()


class ShareUrlTests(unittest.TestCase):
    def test_mobile_share_text_extracts_and_resolves_xhs_short_link(self):
        share_text = "NPD有一个藏不住的语言习惯 https://xhslink.cn/o/3BiMeyL4RcE 前往【小红书】看看"
        self.assertEqual("https://xhslink.cn/o/3BiMeyL4RcE", normalize_url(share_text))
        with patch("utils.httpx.Client", _Client):
            resolved = resolve_share_url(share_text)
        self.assertIn(f"/discovery/item/{NOTE_ID}", resolved)
        self.assertEqual("xiaohongshu", detect_platform(resolved))

    def test_xhslink_cn_is_recognized_even_if_resolution_is_unavailable(self):
        self.assertEqual("xiaohongshu", detect_platform("https://xhslink.cn/o/example"))

    def test_pc_and_mobile_urls_have_one_stable_content_identity(self):
        desktop = (
            f"https://www.xiaohongshu.com/discovery/item/{NOTE_ID}"
            "?source=webshare&xhsshare=pc_web&xsec_token=desktop"
        )
        mobile = (
            f"https://www.xiaohongshu.com/discovery/item/{NOTE_ID}"
            "?app_platform=ios&xsec_source=app_share&xsec_token=mobile"
        )
        self.assertEqual(canonical_content_key(desktop), canonical_content_key(mobile))
        self.assertEqual(url_to_id(desktop), url_to_id(mobile))


if __name__ == "__main__":
    unittest.main()
