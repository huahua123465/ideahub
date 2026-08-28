import json
import unittest
from unittest.mock import AsyncMock, patch
from urllib.parse import quote

from media.profile_extractor import (
    account_from_downloader,
    extract_account_from_html,
    hydrate_account,
    merge_accounts,
    normalize_account,
)


class ProfileExtractorTests(unittest.TestCase):
    def test_xhs_profile_reads_basic_info_and_interactions(self):
        state = {
            "user": {
                "userPageData": {
                    "basicInfo": {
                        "userId": "user-1",
                        "nickname": "小红书博主",
                        "desc": "这是简介",
                    },
                    "interactions": [
                        {"type": "follows", "count": "12"},
                        {"type": "fans", "count": "3.4万"},
                        {"type": "interaction", "count": "88.6万"},
                    ],
                }
            }
        }
        html = f"<script>window.__INITIAL_STATE__={json.dumps(state, ensure_ascii=False)}</script>"

        account = extract_account_from_html(html, "xiaohongshu")

        self.assertEqual("小红书博主", account["name"])
        self.assertEqual("https://www.xiaohongshu.com/user/profile/user-1", account["profile_url"])
        self.assertEqual("这是简介", account["bio"])
        self.assertEqual("12", account["following_count"])
        self.assertEqual("3.4万", account["follower_count"])
        self.assertEqual("88.6万", account["likes_and_collections_count"])

    def test_xhs_note_only_returns_values_exposed_on_note(self):
        state = {
            "note": {
                "noteDetailMap": {
                    "note-1": {"note": {"user": {"userId": "user-2", "nickname": "帖子作者"}}}
                }
            }
        }
        html = f"<script>window.__INITIAL_STATE__={json.dumps(state, ensure_ascii=False)}</script>"

        account = extract_account_from_html(html, "xiaohongshu")

        self.assertEqual("帖子作者", account["name"])
        self.assertEqual("", account["bio"])
        self.assertEqual("", account["follower_count"])

    def test_douyin_render_data_reads_author_profile(self):
        render_data = {
            "videoDetail": {
                "authorInfo": {
                    "nickname": "抖音博主",
                    "secUid": "SEC-UID",
                    "signature": "抖音简介",
                    "followingCount": 0,
                    "followerCount": 12500,
                    "totalFavorited": 98500,
                }
            }
        }
        payload = quote(json.dumps(render_data, ensure_ascii=False))
        html = f'<script id="RENDER_DATA" type="application/json">{payload}</script>'

        account = extract_account_from_html(html, "douyin")

        self.assertEqual("抖音博主", account["name"])
        self.assertEqual("https://www.douyin.com/user/SEC-UID", account["profile_url"])
        self.assertEqual("0", account["following_count"])
        self.assertEqual("12500", account["follower_count"])
        self.assertEqual("98500", account["likes_and_collections_count"])

    def test_merge_fills_blanks_without_overwriting_platform_values(self):
        merged = merge_accounts(
            {"name": "主页名称", "follower_count": "0"},
            {"name": "帖子名称", "bio": "帖子未提供之外的真实简介", "follower_count": "20"},
        )
        self.assertEqual("主页名称", merged["name"])
        self.assertEqual("0", merged["follower_count"])
        self.assertEqual("帖子未提供之外的真实简介", merged["bio"])
        self.assertEqual("", normalize_account({})["following_count"])

    def test_downloader_xhs_uploader_id_becomes_profile_url(self):
        account = account_from_downloader({
            "uploader_id": "user-from-video",
            "webpage_url": "https://www.xiaohongshu.com/discovery/item/note-1",
        })

        self.assertEqual(
            "https://www.xiaohongshu.com/user/profile/user-from-video",
            account["profile_url"],
        )


class AccountHydrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_profile_snapshot_is_retried_before_browser_fallback(self):
        state = {
            "user": {
                "userPageData": {
                    "basicInfo": {"userId": "u1", "nickname": "作者"},
                    "interactions": [
                        {"type": "follows", "count": "10"},
                        {"type": "fans", "count": "20"},
                        {"type": "interaction", "count": "30"},
                    ],
                }
            }
        }
        profile_html = f"<script>window.__INITIAL_STATE__={json.dumps(state)}</script>"
        seed = {
            "name": "作者",
            "profile_url": "https://www.xiaohongshu.com/user/profile/u1",
        }
        with (
            patch("media.profile_extractor._http_html", new=AsyncMock(side_effect=["", profile_html])) as fetch,
            patch("media.profile_extractor._browser_html", new=AsyncMock()) as browser,
            patch("media.profile_extractor.asyncio.sleep", new=AsyncMock()) as sleep,
        ):
            account = await hydrate_account("https://www.xiaohongshu.com/discovery/item/n1", "xiaohongshu", seed)

        self.assertEqual("10", account["following_count"])
        self.assertEqual("20", account["follower_count"])
        self.assertEqual("30", account["likes_and_collections_count"])
        self.assertEqual(2, fetch.await_count)
        self.assertEqual(1, sleep.await_count)
        browser.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
