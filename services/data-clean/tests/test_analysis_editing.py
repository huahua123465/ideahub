import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

import app as app_module
app_module.app.config.update(TESTING=True, COLLECTOR_AUTH_BYPASS_TESTS=True)


class AnalysisEditingTests(unittest.TestCase):
    def _content(self):
        evidence = {
            "id": "comment-1",
            "author": "原评论用户",
            "like_count": 12,
            "text": "这条评论必须保持原样",
        }
        return {
            "title": "编辑测试",
            "source_url": "https://example.com/post",
            "ai_analysis": {
                "status": "ok",
                "video": {
                    "status": "ok",
                    "items": {
                        "main_topic": {"label": "这条主要讲什么", "summary": "原视频结论"},
                    },
                },
                "comments": {
                    "status": "ok",
                    "items": {
                        "main_questions": {
                            "label": "评论主要在问什么",
                            "summary": "原评论结论",
                            "evidence_comments": [evidence],
                        },
                        "key_comments": {
                            "entries": [{"reason": "原重点理由", "comment": evidence}],
                        },
                        "topic_extensions": {
                            "entries": [{"idea": "原选题", "evidence_comments": [evidence]}],
                        },
                    },
                },
            },
        }

    def test_edit_analysis_persists_text_and_preserves_source_evidence(self):
        with TemporaryDirectory() as root:
            task_dir = Path(root) / "task-1"
            task_dir.mkdir()
            content_path = task_dir / "content.json"
            content_path.write_text(
                json.dumps(self._content(), ensure_ascii=False), encoding="utf-8",
            )
            fake_db = Mock()
            fake_db.get_task.return_value = {"id": "task-1", "status": "done"}

            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "db", fake_db),
            ):
                response = app_module.app.test_client().patch(
                    "/api/result/task-1/ai-analysis",
                    json={
                        "video": {"main_topic": "人工修改后的视频结论"},
                        "comments": {"main_questions": "人工修改后的评论结论"},
                        "key_comments": ["人工修改后的重点理由"],
                        "topic_extensions": ["人工修改后的选题"],
                    },
                )

            self.assertEqual(200, response.status_code)
            saved = json.loads(content_path.read_text(encoding="utf-8"))
            analysis = saved["ai_analysis"]
            self.assertEqual(
                "人工修改后的视频结论",
                analysis["video"]["items"]["main_topic"]["summary"],
            )
            self.assertEqual(
                "人工修改后的评论结论",
                analysis["comments"]["items"]["main_questions"]["summary"],
            )
            self.assertEqual(
                "这条评论必须保持原样",
                analysis["comments"]["items"]["main_questions"]["evidence_comments"][0]["text"],
            )
            self.assertEqual(4, analysis["manual_edit"]["edited_fields"])
            self.assertIn(
                "人工修改后的视频结论",
                (task_dir / "content.txt").read_text(encoding="utf-8"),
            )

    def test_rejects_attempt_to_edit_source_evidence(self):
        with TemporaryDirectory() as root:
            task_dir = Path(root) / "task-1"
            task_dir.mkdir()
            content_path = task_dir / "content.json"
            original = self._content()
            content_path.write_text(
                json.dumps(original, ensure_ascii=False), encoding="utf-8",
            )
            fake_db = Mock()
            fake_db.get_task.return_value = {"id": "task-1", "status": "done"}

            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "db", fake_db),
            ):
                response = app_module.app.test_client().patch(
                    "/api/result/task-1/ai-analysis",
                    json={"evidence_comments": [{"text": "试图篡改原话"}]},
                )

            self.assertEqual(400, response.status_code)
            saved = json.loads(content_path.read_text(encoding="utf-8"))
            self.assertEqual(
                "这条评论必须保持原样",
                saved["ai_analysis"]["comments"]["items"]["main_questions"]
                ["evidence_comments"][0]["text"],
            )


if __name__ == "__main__":
    unittest.main()
