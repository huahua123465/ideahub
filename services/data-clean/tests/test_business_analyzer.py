import unittest
from unittest.mock import patch

from generators import business_analyzer


class BusinessAnalyzerTests(unittest.TestCase):
    def setUp(self):
        self.content = {
            "title": "怎么选通勤跑鞋",
            "description": "三步判断脚型和使用场景",
            "page_text": "先确认路面和里程，再看支撑与缓震，最后试穿。",
            "engagement": {"likes": "1200", "collects": "380", "comments": "2"},
            "images": [],
            "comments": [
                {
                    "id": "c1", "author": "小林", "text": "扁平足每天走一万步怎么选？",
                    "like_count": 38, "type": "comment",
                },
                {
                    "id": "c2", "author": "阿晴", "text": "能不能讲讲预算五百以内的型号？",
                    "like_count": 26, "type": "comment",
                },
            ],
        }

    def test_fixed_video_sections_and_original_comment_evidence(self):
        video_response = {
            "main_topic": "讲解通勤跑鞋的选择步骤。",
            "target_audience": "需要日常步行或通勤跑鞋的人。",
            "user_need": "降低选鞋试错成本。",
            "content_structure": "按场景、支撑缓震、试穿三步展开。",
            "solution": "给出三步筛选方法。",
            "references": "结构清楚，适合做清单型内容。",
            "extensions": "可继续做不同脚型和预算的选鞋清单。",
        }
        comment_response = {
            "main_questions": {"summary": "主要询问脚型适配。", "comment_ids": ["c1"]},
            "high_frequency_needs": {"summary": "需要具体型号和预算建议。", "comment_ids": ["c2"]},
            "worries": {"summary": "担心长距离步行不舒适。", "comment_ids": ["c1"]},
            "unclear_points": {"summary": "没有给出明确价位和型号。", "comment_ids": ["c2"]},
            "key_comments": [{"comment_id": "c1", "reason": "场景和脚型都很具体。"}],
            "topic_extensions": [{"idea": "500 元以内通勤鞋清单", "comment_ids": ["c2"]}],
        }

        with patch.object(business_analyzer, "_chat_json", side_effect=[video_response, comment_response]):
            result = business_analyzer.analyze_content(self.content)

        self.assertEqual("ok", result["status"])
        self.assertEqual(7, len(result["video"]["items"]))
        evidence = result["comments"]["items"]["main_questions"]["evidence_comments"][0]
        self.assertEqual("c1", evidence["id"])
        self.assertEqual("扁平足每天走一万步怎么选？", evidence["text"])
        self.assertNotIn("comment_ids", result["comments"]["items"]["main_questions"])

    def test_invalid_model_comment_id_is_not_exposed_as_quote(self):
        video_response = {key: label for key, label in business_analyzer.VIDEO_FIELDS}
        comment_response = {
            key: {"summary": "样本不足。", "comment_ids": ["invented"]}
            for key, _label in business_analyzer.COMMENT_FIELDS
        }
        comment_response.update({"key_comments": [], "topic_extensions": []})

        with patch.object(business_analyzer, "_chat_json", side_effect=[video_response, comment_response]):
            result = business_analyzer.analyze_content(self.content)

        self.assertEqual([], result["comments"]["items"]["main_questions"]["evidence_comments"])

    def test_one_model_failure_returns_partial_without_losing_other_analysis(self):
        comment_response = {
            key: {"summary": "样本结论。", "comment_ids": ["c1"]}
            for key, _label in business_analyzer.COMMENT_FIELDS
        }
        comment_response.update({"key_comments": [], "topic_extensions": []})

        with patch.object(
            business_analyzer,
            "_chat_json",
            side_effect=[RuntimeError("video provider down"), comment_response],
        ):
            result = business_analyzer.analyze_content(self.content)

        self.assertEqual("partial", result["status"])
        self.assertEqual("unavailable", result["video"]["status"])
        self.assertEqual("ok", result["comments"]["status"])

    def test_technical_audit_is_separate_and_contains_checkable_basis(self):
        video_response = {
            key: {
                "summary": label,
                "basis": f"依据文字标题归纳：{label}",
                "source_labels": ["文字标题"],
            }
            for key, label in business_analyzer.VIDEO_FIELDS
        }
        comment_response = {
            key: {
                "summary": "样本结论。",
                "basis": "由评论中的明确问题归纳，样本仅两条。",
                "comment_ids": ["c1"],
            }
            for key, _label in business_analyzer.COMMENT_FIELDS
        }
        comment_response.update({"key_comments": [], "topic_extensions": []})

        with patch.object(business_analyzer, "_chat_json", side_effect=[video_response, comment_response]):
            analysis, audit = business_analyzer.analyze_content_with_audit(self.content)

        self.assertNotIn("_audit", analysis["video"])
        self.assertEqual("technical", audit["audience"])
        self.assertEqual("model_supplied", audit["video"]["items"]["main_topic"]["basis_origin"])
        self.assertEqual(["文字标题"], audit["video"]["items"]["main_topic"]["source_labels"])
        self.assertEqual("c1", audit["comments"]["items"]["main_questions"]["evidence_comments"][0]["id"])
        markdown = business_analyzer.build_technical_audit_markdown(audit)
        self.assertIn("# AI 分析技术审计", markdown)
        self.assertIn("可核对依据", markdown)


if __name__ == "__main__":
    unittest.main()
