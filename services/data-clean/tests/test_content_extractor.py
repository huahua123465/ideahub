import unittest
import json

from media.content_extractor import (
    clean_post_title,
    _dedupe_text_blocks,
    _extract_engagement,
    _extract_images,
    _extract_topics,
    _near_duplicate,
    _page_headers,
    _parse_html,
    strip_topics_from_description,
)


class ContentDeduplicationTests(unittest.TestCase):
    def test_page_snapshot_keeps_content_id_and_publish_time(self):
        html = '''<html><head><title>图文作品</title>
        <meta property="article:published_time" content="2026-08-29T01:02:03+08:00">
        </head><body><script>window.__INITIAL_STATE__={"noteId":"note-123456"};</script>
        <article>这是一段足够长的公开正文，用于验证作品身份与发布时间可以进入原始归档结果。</article>
        </body></html>'''
        result = _parse_html(html, "https://www.xiaohongshu.com/explore/note-123456")

        self.assertEqual("note-123456", result["platform_content_id"])
        self.assertEqual("2026-08-29T01:02:03+08:00", result["published_at"])

    def test_current_url_id_wins_over_recommended_note_preload(self):
        html = '''<html><head><title>当前作品</title></head><body>
        <script>{"noteId":"recommended-999999","time":1700000000}</script>
        <article>这是一段足够长的当前作品正文，用来确认推荐列表里的编号不会污染当前样本身份。</article>
        </body></html>'''
        result = _parse_html(html, "https://www.xiaohongshu.com/explore/current-123456")
        self.assertEqual("current-123456", result["platform_content_id"])
        self.assertEqual("", result["published_at"])

    def test_public_mode_never_builds_a_cookie_header(self):
        headers = _page_headers(
            "https://www.xiaohongshu.com/explore/note-id", use_login=False,
        )
        self.assertNotIn("Cookie", headers)

    def test_xhs_structured_image_list_keeps_extensionless_cdn_urls(self):
        first = "https://sns-webpic-qc.xhscdn.com/202608281234/first-image"
        second = "https://sns-webpic-qc.xhscdn.com/202608281234/second-image"
        initial_state = {"note": {"noteDetailMap": {"x": {"note": {
            "imageList": [
                {"urlDefault": first, "width": 1080, "height": 1440},
                {"infoList": [{"imageScene": "WB_DFT", "url": second}]},
            ],
        }}}}}
        page_html = f'''<html><head><title>图文笔记</title></head><body>
        <script>window.__INITIAL_STATE__={json.dumps(initial_state)};</script>
        <article>足够长的图文笔记正文内容，用来通过页面解析的最小长度检查。</article>
        </body></html>'''

        self.assertEqual([first, second], _extract_images(page_html, "https://www.xiaohongshu.com/explore/x"))

    def test_post_metadata_is_named_and_split(self):
        self.assertEqual("异性缘爆棚的男生", clean_post_title("异性缘爆棚的男生 - 小红书"))
        self.assertEqual(
            "这是作品描述。",
            strip_topics_from_description(
                "这是作品描述。 #男生特质 #情感干货 #",
                ["男生特质", "情感干货"],
            ),
        )

    def test_topic_only_description_becomes_empty(self):
        self.assertEqual(
            "",
            strip_topics_from_description("#新人主播必看 #直播技巧 #", ["新人主播必看", "直播技巧"]),
        )

    def test_topic_only_description_without_first_hash_becomes_empty(self):
        self.assertEqual(
            "",
            strip_topics_from_description(
                "女孩子[话题]# #女性成长[话题]#",
                ["女孩子", "女性成长"],
            ),
        )

    def test_engagement_uses_xhs_metadata(self):
        html = '''<meta property="og:xhs:note_like" content="4.3万">
        <meta property="og:xhs:note_collect" content="2.8万">
        <meta property="og:xhs:note_comment" content="575">'''
        self.assertEqual(
            {"likes": "4.3万", "collects": "2.8万", "comments": "575"},
            _extract_engagement(html),
        )

    def test_topics_are_split_and_deduplicated(self):
        html = '<meta name="keywords" content="提升亲密关系, 恋爱观, 爱情观">'
        description = "正文 #提升亲密关系 #恋爱观 #爱情观"
        self.assertEqual(
            ["提升亲密关系", "恋爱观", "爱情观"],
            _extract_topics(html, description),
        )

    def test_near_duplicate_ignores_topic_markup_and_whitespace(self):
        description = "恋爱需要相互尊重，也需要自己的空间。" * 4
        body = "恋爱需要相互尊重，也需要自己的空间。 " * 4 + "#恋爱观[话题]#"
        self.assertTrue(_near_duplicate(description, body, threshold=0.92))

    def test_description_copy_and_nested_block_are_removed(self):
        description = "这是平台描述，包含完整的帖子内容。" * 5
        blocks, matched = _dedupe_text_blocks([
            description,
            description + " #话题[话题]#",
            "这是一段真正独立的补充正文，内容与描述并不相同。",
            "这是一段真正独立的补充正文，内容与描述并不相同。",
        ], description=description, title="帖子标题")

        self.assertTrue(matched)
        self.assertEqual(["这是一段真正独立的补充正文，内容与描述并不相同。"], blocks)

    def test_parse_marks_body_that_only_duplicates_description(self):
        description = "这是帖子正文，也是元数据描述。" * 8
        html = f'''<html><head><title>示例帖子</title>
        <meta property="og:description" content="{description}"></head>
        <body><script>window.__data={{"note_desc":"{description}"}}</script>
        <article>{description}</article></body></html>'''
        result = _parse_html(html)

        self.assertEqual("", result["text"])
        self.assertTrue(result["text_same_as_description"])
        self.assertEqual(description, result["description"])
        self.assertEqual("示例帖子", result["post_title"])
        self.assertEqual(description, result["post_description"])


if __name__ == "__main__":
    unittest.main()
