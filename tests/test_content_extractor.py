import unittest

from media.content_extractor import (
    clean_post_title,
    _dedupe_text_blocks,
    _extract_engagement,
    _extract_topics,
    _near_duplicate,
    _parse_html,
    strip_topics_from_description,
)


class ContentDeduplicationTests(unittest.TestCase):
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
