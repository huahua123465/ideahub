import unittest

from app import _build_export_text, _safe_export_name


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.content = {
            "title": "示例/文章",
            "post_title": "示例/文章",
            "cover_title": "封面示例标题",
            "display_title": "封面示例标题",
            "collection_mode": "archive",
            "collection_mode_label": "完整归档",
            "storage": {"policy": "persistent"},
            "author": "作者",
            "account": {
                "name": "示例博主",
                "profile_url": "https://example.com/user/1",
                "bio": "账号简介",
                "following_count": "12",
                "follower_count": "3.4万",
                "likes_and_collections_count": "88.6万",
            },
            "source_url": "https://example.com/post",
            "description": "文章描述",
            "post_description": "文章描述",
            "engagement": {"likes": "4.3万", "collects": "2.8万", "comments": "575"},
            "topics": ["提升亲密关系", "恋爱观", "爱情观"],
            "images": [{"index": 1, "source_url": "https://img/1", "text": "图片文字"}],
            "comments": [{
                "id": "c1",
                "type": "reply", "author": "用户", "reply_to_author": "楼主",
                "like_count": 66, "text": "回复内容",
            }],
            "ai_analysis": {
                "notice": "AI 仅作辅助整理。",
                "video": {"items": {
                    "main_topic": {"label": "这条主要讲什么", "summary": "讲解示例主题。"},
                }},
                "comments": {"items": {
                    "main_questions": {
                        "label": "大家主要在问什么", "summary": "主要询问执行方法。",
                        "evidence_comments": [{
                            "id": "c1", "author": "用户", "like_count": 66,
                            "text": "回复内容",
                        }],
                    },
                }},
            },
        }

    def test_txt_export_contains_complete_content_sections(self):
        exported = _build_export_text(self.content, "txt")
        for expected in ("点赞量：4.3万", "收藏量：2.8万", "评论量：575",
                         "采集模式：完整归档", "素材策略：persistent",
                         "账号名称：示例博主", "粉丝量：3.4万", "获赞与收藏量：88.6万",
                         "#提升亲密关系", "封面标题：\n封面示例标题",
                         "文字标题：\n示例/文章", "OCR：\n图片文字", "[回复] 用户 → @楼主"):
            self.assertIn(expected, exported)

    def test_markdown_export_has_headings_and_topics(self):
        exported = _build_export_text(self.content, "md")
        self.assertIn("# 封面示例标题", exported)
        self.assertIn("## 作品描述", exported)
        self.assertIn("## 封面标题", exported)
        self.assertIn("#恋爱观", exported)
        self.assertIn("AI 视频分析", exported)
        self.assertIn("这条主要讲什么：讲解示例主题。", exported)
        self.assertIn("代表评论｜用户 · 66 赞：回复内容", exported)

    def test_filename_is_safe(self):
        self.assertEqual("示例_文章", _safe_export_name("示例/文章"))


if __name__ == "__main__":
    unittest.main()
