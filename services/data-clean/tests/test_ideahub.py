import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import app as app_module


class _IdeaHubResponse:
    status_code = 200

    @staticmethod
    def json():
        return {
            "ok": True,
            "taskId": "source-task",
            "sourceRef": "t1:source-task",
            "title": "原样 JSON 测试",
            "results": [{
                "channel": "persona",
                "board": "persona",
                "id": 183,
                "created": True,
                "accountId": 11,
                "tagsApplied": 2,
            }],
            "by": "技术1",
            "internal": "must-not-be-proxied",
        }


class _IdeaHubClient:
    captured = None

    def __init__(self, **options):
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def post(self, url, **kwargs):
        type(self).captured = {"url": url, "options": self.options, **kwargs}
        return _IdeaHubResponse()


class IdeaHubPushTests(unittest.TestCase):
    def setUp(self):
        app_module.app.config["TESTING"] = True
        _IdeaHubClient.captured = None

    def test_status_exposes_configuration_state_without_the_key(self):
        with patch.object(app_module, "IDEAHUB_API_KEY", ""):
            payload = app_module.app.test_client().get("/api/ideahub/status").get_json()

        self.assertFalse(payload["configured"])
        self.assertEqual("真人作品 → 对标账号", payload["channels"]["persona"])
        self.assertEqual("矩阵作品 → 对标账号", payload["channels"]["matrix"])
        self.assertNotIn("api_key", payload)

    def test_push_sends_the_saved_json_bytes_without_reformatting(self):
        raw_json = ('{\n  "task_id" : "source-task",\n  "title" : "原样 JSON 测试"\n}\n').encode("utf-8")
        with TemporaryDirectory() as root:
            task_dir = Path(root) / "task-1"
            task_dir.mkdir()
            (task_dir / "content.json").write_bytes(raw_json)

            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "IDEAHUB_API_KEY", "server-only-key"),
                patch.object(app_module, "IDEAHUB_INGEST_URL", "https://ideahub.example/api/ingest/analysis"),
                patch.object(app_module.httpx, "Client", _IdeaHubClient),
            ):
                response = app_module.app.test_client().post(
                    "/api/ideahub/push/task-1",
                    json={"channel": "persona"},
                )

        self.assertEqual(200, response.status_code)
        self.assertEqual(raw_json, _IdeaHubClient.captured["content"])
        self.assertEqual(
            "https://ideahub.example/api/ingest/analysis?channel=persona",
            _IdeaHubClient.captured["url"],
        )
        self.assertEqual("Bearer server-only-key", _IdeaHubClient.captured["headers"]["Authorization"])
        self.assertEqual("application/json; charset=utf-8", _IdeaHubClient.captured["headers"]["Content-Type"])
        self.assertFalse(_IdeaHubClient.captured["options"]["follow_redirects"])

        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual("真人作品 → 对标账号", payload["destination"])
        self.assertNotIn("internal", payload)
        self.assertNotIn("server-only-key", json.dumps(payload, ensure_ascii=False))

    def test_channel_is_required_and_allowlisted(self):
        with patch.object(app_module, "IDEAHUB_API_KEY", "server-only-key"):
            client = app_module.app.test_client()
            missing = client.post("/api/ideahub/push/task-1", json={})
            invalid = client.post("/api/ideahub/push/task-1", json={"channel": "live"})

        self.assertEqual(400, missing.status_code)
        self.assertEqual(400, invalid.status_code)

    def test_missing_server_key_returns_actionable_error(self):
        with patch.object(app_module, "IDEAHUB_API_KEY", ""):
            response = app_module.app.test_client().post(
                "/api/ideahub/push/task-1",
                json={"channel": "matrix"},
            )

        self.assertEqual(503, response.status_code)
        self.assertIn("IDEAHUB_API_KEY", response.get_json()["error"])

    def test_analysis_payload_limit_matches_ideahub_eight_megabytes(self):
        with TemporaryDirectory() as root:
            task_dir = Path(root) / "task-1"
            task_dir.mkdir()
            oversized = b'{"payload":"' + (b"x" * app_module.IDEAHUB_MAX_PAYLOAD_BYTES) + b'"}'
            (task_dir / "content.json").write_bytes(oversized)

            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "IDEAHUB_API_KEY", "server-only-key"),
            ):
                response = app_module.app.test_client().post(
                    "/api/ideahub/push/task-1",
                    json={"channel": "matrix"},
                )

        self.assertEqual(413, response.status_code)
        self.assertIn("8MB", response.get_json()["error"])

    def test_batch_push_deduplicates_ids_and_preserves_each_json(self):
        captured = []

        def post(payload, channel):
            captured.append((payload, channel))
            return {
                "ok": True,
                "taskId": json.loads(payload)["task_id"],
                "title": "批量作品",
                "results": [{"channel": channel, "id": len(captured), "created": True}],
            }

        with TemporaryDirectory() as root:
            for task_id, raw in (("task-1", b'{"task_id":"one"}\n'), ("task-2", b'{"task_id":"two"}\n')):
                task_dir = Path(root) / task_id
                task_dir.mkdir()
                (task_dir / "content.json").write_bytes(raw)

            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "IDEAHUB_API_KEY", "server-only-key"),
                patch.object(app_module, "_post_ideahub_analysis", side_effect=post),
            ):
                response = app_module.app.test_client().post(
                    "/api/ideahub/push-batch",
                    json={"task_ids": ["task-1", "task-1", "task-2"], "channel": "matrix"},
                )

        self.assertEqual(200, response.status_code)
        payload = response.get_json()
        self.assertTrue(payload["ok"])
        self.assertEqual(2, payload["total"])
        self.assertEqual(2, payload["succeeded"])
        self.assertEqual([(b'{"task_id":"one"}\n', "matrix"), (b'{"task_id":"two"}\n', "matrix")], captured)

    def test_batch_push_keeps_per_item_failures_for_retry(self):
        with TemporaryDirectory() as root:
            task_dir = Path(root) / "task-1"
            task_dir.mkdir()
            (task_dir / "content.json").write_bytes(b'{"task_id":"one"}')

            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "IDEAHUB_API_KEY", "server-only-key"),
                patch.object(app_module, "_post_ideahub_analysis", return_value={
                    "ok": True, "results": [{"channel": "persona", "id": 1}],
                }),
            ):
                response = app_module.app.test_client().post(
                    "/api/ideahub/push-batch",
                    json={"task_ids": ["task-1", "missing"], "channel": "persona"},
                )

        payload = response.get_json()
        self.assertEqual(200, response.status_code)
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["partial"])
        self.assertEqual(1, payload["succeeded"])
        self.assertEqual(1, payload["failed"])
        self.assertEqual("missing", payload["items"][1]["task_id"])
        self.assertIn("完整 JSON", payload["items"][1]["error"])


if __name__ == "__main__":
    unittest.main()
