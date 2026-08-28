import unittest
import base64
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

import app as app_module
app_module.app.config.update(TESTING=True, COLLECTOR_AUTH_BYPASS_TESTS=True)
from app import (
    COLLECTION_MODE,
    COLLECTION_MODE_LABEL,
    STORAGE_POLICY,
    _backfill_video_evidence,
    _find_equivalent_task,
)


class CollectionModeTests(unittest.TestCase):
    def test_equivalent_xhs_share_url_reuses_existing_task(self):
        note_id = "6a6e0eb80000000005031f6f"
        desktop = f"https://www.xiaohongshu.com/discovery/item/{note_id}?source=pc_share"
        mobile = f"https://www.xiaohongshu.com/discovery/item/{note_id}?source=app_share"
        fake_db = unittest.mock.Mock()
        fake_db.list_tasks.return_value = [{"id": "desktop-task", "url": desktop, "owner_id": "owner-1"}]
        with patch.object(app_module, "db", fake_db):
            self.assertEqual("desktop-task", _find_equivalent_task(mobile, "owner-1")["id"])

    def test_analysis_with_source_links_is_the_default(self):
        self.assertEqual("analyze", COLLECTION_MODE)
        self.assertEqual("采集分析", COLLECTION_MODE_LABEL)
        self.assertEqual("source_linked", STORAGE_POLICY)

    def test_failed_result_returns_the_recorded_error(self):
        fake_db = unittest.mock.Mock()
        fake_db.get_task.return_value = {
            "id": "task-1",
            "status": "failed",
            "error_msg": "视频模型请求失败",
        }
        with patch.object(app_module, "db", fake_db):
            response = app_module.app.test_client().get("/api/result/task-1")
        self.assertEqual(409, response.status_code)
        self.assertEqual({
            "error": "视频模型请求失败",
            "status": "failed",
        }, response.get_json())

    def test_manual_refresh_reuses_the_same_task_and_history_row(self):
        fake_db = unittest.mock.Mock()
        fake_db.get_task.return_value = {
            "id": "task-1", "status": "done", "url": "https://example.com/post",
        }
        with TemporaryDirectory() as root:
            task_dir = Path(root) / "task-1"
            task_dir.mkdir()
            (task_dir / "content.json").write_text('{"task_id":"task-1"}', encoding="utf-8")
            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "db", fake_db),
                patch.object(app_module, "_running", {}),
                patch.object(app_module.threading, "Thread") as thread,
            ):
                response = app_module.app.test_client().post("/api/task/task-1/refresh")

        self.assertEqual(200, response.status_code)
        self.assertTrue(response.get_json()["manual_refresh"])
        self.assertIs(app_module._run_pipeline_in_slot, thread.call_args.kwargs["target"])
        self.assertEqual(("task-1", "https://example.com/post", True), thread.call_args.kwargs["args"])
        fake_db.create_task.assert_not_called()


class _FakeDB:
    def add_artifact(self, *args, **kwargs):
        return None

    def update_status(self, *args, **kwargs):
        return None

    def get_task(self, _vid):
        return {"id": "task-1", "status": "done"}


def _analysis_with_audit(analysis=None):
    return (
        analysis or {
            "schema_version": 1,
            "status": "ok",
            "video": {"status": "ok", "items": {}},
            "comments": {"status": "empty", "items": {}},
        },
        {
            "task_id": "task-1",
            "model": "test-model",
            "generated_at": "2026-08-25T00:00:00+00:00",
            "analysis_status": "ok",
            "disclaimer": "技术审计测试",
            "video": {"items": {}},
            "comments": {"sample_size": 0, "items": {}},
        },
    )


class TechnicalAuditDownloadTests(unittest.TestCase):
    def test_result_reports_audit_and_download_is_local_only(self):
        with TemporaryDirectory() as root:
            task_dir = Path(root) / "task-1"
            task_dir.mkdir()
            (task_dir / "content.json").write_text(json.dumps({
                "schema_version": 13,
                "task_id": "task-1",
                "media_type": "image_post",
                "title": "测试任务",
                "post_title": "测试任务",
                "description": "",
                "post_description": "",
                "images": [],
                "media_assets": {"video": {}},
            }), encoding="utf-8")
            (task_dir / "ai_analysis.technical.json").write_text(
                '{"audience":"technical"}', encoding="utf-8",
            )
            (task_dir / "ai_analysis.technical.md").write_text(
                "# AI 分析技术审计\n", encoding="utf-8",
            )
            fake_db = unittest.mock.Mock()
            fake_db.get_task.return_value = {"id": "task-1", "status": "done", "title": "测试任务"}

            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "db", fake_db),
            ):
                client = app_module.app.test_client()
                result = client.get("/api/result/task-1").get_json()
                download = client.get("/api/technical-audit/task-1/json")
                remote_download = client.get(
                    "/api/technical-audit/task-1/md",
                    environ_base={"REMOTE_ADDR": "192.168.1.8"},
                )
                download_status = download.status_code
                download_disposition = download.headers["Content-Disposition"]
                remote_status = remote_download.status_code
                download.close()
                remote_download.close()

        self.assertTrue(result["technical_audit"]["available"])
        self.assertEqual(["json", "md"], result["technical_audit"]["formats"])
        self.assertEqual(200, download_status)
        self.assertIn("attachment", download_disposition)
        self.assertEqual(403, remote_status)


class PipelineStorageTests(unittest.TestCase):
    @staticmethod
    async def _page(_url):
        return {
            "title": "示例图文",
            "description": "描述",
            "text": "正文",
            "text_same_as_description": False,
            "engagement": {"likes": "1", "collects": "2", "comments": "3"},
            "topics": [],
            "images": ["https://img/1"],
            "account": {},
        }

    @staticmethod
    async def _account(_url, _platform, seed):
        return seed

    @staticmethod
    async def _comments(_url, _platform):
        return {"comments": [], "comment_summary": {"status": "ok", "threshold": 20}}

    @staticmethod
    def _download_images(urls, output_dir, _referer, diagnostics=None):
        image_dir = Path(output_dir) / "images"
        image_dir.mkdir(parents=True, exist_ok=True)
        image_path = image_dir / "image_01.webp"
        image_path.write_bytes(b"test-image")
        result = [{
            "path": str(image_path), "source_url": urls[0],
            "width": 1080, "height": 1350, "size_bytes": image_path.stat().st_size,
        }]
        if diagnostics is not None:
            diagnostics.update({
                "discovered": len(urls), "downloaded": 1, "failed": 0,
                "rejected_payload": 0, "rejected_dimensions": 0,
            })
        return result

    def _run(self, root, manual_refresh=False):
        if manual_refresh:
            task_dir = Path(root) / "task-1"
            task_dir.mkdir(parents=True, exist_ok=True)
            (task_dir / "content.json").write_text(
                '{"task_id":"task-1","title":"旧结果","old_marker":true}',
                encoding="utf-8",
            )
        with (
            patch.object(app_module, "OUTPUT_DIR", Path(root)),
            patch.object(app_module, "db", _FakeDB()),
            patch.object(app_module, "detect_platform", return_value="xiaohongshu"),
            patch.object(app_module, "extract_video_metadata", return_value=None),
            patch.object(app_module, "extract_page", side_effect=self._page),
            patch.object(app_module, "hydrate_account", side_effect=self._account),
            patch.object(app_module, "extract_hot_comments", side_effect=self._comments),
            patch.object(app_module, "analyze_content_with_audit", return_value=_analysis_with_audit()),
            patch.object(app_module, "download_post_images", side_effect=self._download_images),
            patch.object(
                app_module, "extract_images_text",
                side_effect=lambda items: [{
                    **item,
                    "text": "OCR 结果",
                    "cover_title": {
                        "text": "封面大标题", "confidence": 0.98,
                        "font_ratio": 2.4, "line_count": 1,
                        "source_image_index": 1,
                    },
                } for item in items],
            ),
        ):
            app_module._run_pipeline(
                "task-1", "https://example.com/post", manual_refresh=manual_refresh,
            )
        return json.loads((Path(root) / "task-1" / "content.json").read_text(encoding="utf-8"))

    def test_image_posts_retain_downloaded_images_for_evidence(self):
        with TemporaryDirectory() as root:
            content = self._run(root)
            task_dir = Path(root) / "task-1"
            self.assertEqual("analyze", content["collection_mode"])
            self.assertEqual("采集分析", content["collection_mode_label"])
            self.assertEqual("source_linked", content["storage"]["policy"])
            self.assertTrue(content["storage"]["local_media_retained"])
            self.assertFalse(content["storage"]["temporary_media_deleted"])
            self.assertEqual("image_01.webp", content["images"][0]["filename"])
            self.assertEqual("OCR 结果", content["images"][0]["text"])
            self.assertTrue((task_dir / "images" / "image_01.webp").exists())
            self.assertNotIn("technical_audit", content)
            self.assertTrue((task_dir / "ai_analysis.technical.json").exists())
            self.assertTrue((task_dir / "ai_analysis.technical.md").exists())

    def test_successful_manual_refresh_atomically_replaces_the_old_result(self):
        with TemporaryDirectory() as root:
            content = self._run(root, manual_refresh=True)
            root_path = Path(root)

            self.assertTrue(content["manual_refresh"])
            self.assertNotIn("old_marker", content)
            self.assertFalse((root_path / ".refresh-task-1").exists())
            self.assertFalse((root_path / ".refresh-backup-task-1").exists())

    def test_failed_manual_refresh_preserves_the_previous_result(self):
        async def missing_page(_url):
            return None

        with TemporaryDirectory() as root:
            root_path = Path(root)
            task_dir = root_path / "task-1"
            task_dir.mkdir()
            original = b'{"task_id":"task-1","title":"keep-me"}\n'
            (task_dir / "content.json").write_bytes(original)
            fake_db = unittest.mock.Mock()
            running = {}
            with (
                patch.object(app_module, "OUTPUT_DIR", root_path),
                patch.object(app_module, "db", fake_db),
                patch.object(app_module, "_running", running),
                patch.object(app_module, "detect_platform", return_value="xiaohongshu"),
                patch.object(app_module, "url_declares_video", return_value=False),
                patch.object(app_module, "extract_video_metadata", return_value=None),
                patch.object(app_module, "extract_page", side_effect=missing_page),
            ):
                app_module._run_pipeline(
                    "task-1", "https://example.com/post", manual_refresh=True,
                )

            self.assertEqual(original, (task_dir / "content.json").read_bytes())
            self.assertEqual("failed", running["task-1"]["status"])
            self.assertTrue(running["task-1"]["manual_refresh"])
            fake_db.update_status.assert_not_called()
            self.assertFalse((root_path / ".refresh-task-1").exists())

    def test_explicit_video_url_is_not_downgraded_when_metadata_probe_misses(self):
        async def page(_url):
            return {
                "title": "明确的视频",
                "post_title": "明确的视频",
                "post_description": "",
                "engagement": {},
                "topics": [],
                "account": {},
            }

        def download(_url, output_dir, metadata=None):
            self.assertIsNone(metadata)
            path = Path(output_dir) / "temporary.mp4"
            path.write_bytes(b"video")
            return {"video_path": str(path), "duration": 12.0}

        with TemporaryDirectory() as root:
            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "db", _FakeDB()),
                patch.object(app_module, "detect_platform", return_value="xiaohongshu"),
                patch.object(app_module, "url_declares_video", return_value=True),
                patch.object(app_module, "extract_video_metadata", return_value=None),
                patch.object(app_module, "extract_page", side_effect=page),
                patch.object(app_module, "download_video", side_effect=download),
                patch.object(app_module, "transcribe_video_with_model", return_value={
                    "text": "[00:01] 字幕",
                    "status": "ok",
                    "method": "moxus_video",
                    "model": "gemini-3.6-flash",
                }),
                patch.object(app_module, "hydrate_account", side_effect=self._account),
                patch.object(app_module, "extract_hot_comments", side_effect=self._comments),
                patch.object(app_module, "analyze_content_with_audit", return_value=_analysis_with_audit()),
            ):
                app_module._run_pipeline(
                    "task-video-hint",
                    "https://www.xiaohongshu.com/discovery/item/n1?type=video",
                )
            content = json.loads(
                (Path(root) / "task-video-hint" / "content.json").read_text(encoding="utf-8")
            )

        self.assertEqual("video", content["media_type"])
        self.assertEqual("[00:01] 字幕", content["video_text"])
        self.assertEqual("video_download", content["collection_status"]["media"]["method"])

    def test_result_api_can_render_remote_images_without_local_files(self):
        with TemporaryDirectory() as root:
            task_dir = Path(root) / "task-1"
            task_dir.mkdir()
            (task_dir / "content.json").write_text(json.dumps({
                "schema_version": 7,
                "collection_mode": "quick",
                "images": [{
                    "index": 1, "filename": "", "source_url": "https://img/remote",
                    "width": 0, "height": 0, "size_bytes": 0, "text": "",
                }],
                "media_assets": {"video": {}},
            }), encoding="utf-8")
            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "db", _FakeDB()),
            ):
                response = app_module.app.test_client().get("/api/result/task-1")
            self.assertEqual(200, response.status_code)
            image = response.get_json()["images"][0]
            self.assertEqual("https://img/remote", image["url"])
            self.assertFalse(image["stored_locally"])

    def test_old_video_result_backfills_account_engagement_and_specs(self):
        content = {
            "source_url": "https://www.xiaohongshu.com/discovery/item/n1",
            "platform": "xiaohongshu",
            "media_type": "video",
            "description": "#话题[话题]#",
            "post_description": "#话题[话题]#",
            "topics": [],
            "account": app_module.empty_account(),
            "engagement": {"likes": "", "collects": "", "comments": ""},
            "media_assets": {"video": {"source_url": "https://source"}},
        }

        async def page(_url):
            return {
                "topics": ["话题"],
                "post_description": "",
                "engagement": {"likes": "3.9万", "collects": "3.1万", "comments": "633"},
                "account": {"name": "作者", "profile_url": "https://profile"},
            }

        async def account(_url, _platform, seed):
            return {**app_module.empty_account(), **seed, "follower_count": "100"}

        with (
            patch.object(app_module, "extract_video_metadata", return_value={
                "webpage_url": "https://video-source", "duration": 296.1,
                "width": 1080, "height": 1920, "filesize": 49_000_000,
            }),
            patch.object(app_module, "extract_page", side_effect=page),
            patch.object(app_module, "hydrate_account", side_effect=account),
        ):
            changed = _backfill_video_evidence(content)

        self.assertTrue(changed)
        self.assertEqual("作者", content["account"]["name"])
        self.assertEqual("100", content["account"]["follower_count"])
        self.assertEqual("3.9万", content["engagement"]["likes"])
        self.assertEqual(["话题"], content["topics"])
        self.assertEqual("", content["post_description"])
        self.assertEqual(296.1, content["media_assets"]["video"]["duration_seconds"])

    def test_current_schema_result_never_runs_legacy_network_backfill(self):
        content = {
            "schema_version": 13,
            "media_type": "video",
            "source_url": "https://example.com/video",
            "account": {},
            "engagement": {},
            "media_assets": {"video": {}},
            "cover_title": "",
        }
        with patch.object(app_module, "extract_video_metadata") as extract_metadata:
            changed = _backfill_video_evidence(content)

        self.assertFalse(changed)
        extract_metadata.assert_not_called()

    def test_convert_always_uses_analysis_even_if_old_client_sends_quick(self):
        fake_db = unittest.mock.Mock()
        fake_db.get_task.return_value = None
        with (
            patch.object(app_module, "db", fake_db),
            patch.object(app_module, "_running", {}),
            patch.object(app_module, "_find_equivalent_task", return_value=None),
            patch.object(app_module, "resolve_share_url", return_value="https://www.xiaohongshu.com/explore/test"),
            patch.object(app_module, "validate_public_url", side_effect=lambda value: value),
            patch.object(app_module, "_owner_task_id", return_value="task-api"),
            patch.object(app_module.threading, "Thread") as thread,
        ):
            response = app_module.app.test_client().post(
                "/api/convert",
                json={"url": "https://www.xiaohongshu.com/explore/test", "collection_mode": "quick"},
                headers={"X-IdeaHub-User-Id": "test-user"},
            )
        self.assertEqual(200, response.status_code)
        payload = response.get_json()
        self.assertEqual("analyze", payload["collection_mode"])
        self.assertEqual("pending", payload["status"])
        self.assertEqual(1, payload["max_concurrent"])
        self.assertIs(app_module._run_pipeline_in_slot, thread.call_args.kwargs["target"])
        self.assertEqual(("task-api", "https://www.xiaohongshu.com/explore/test"), thread.call_args.kwargs["args"])

    def test_video_is_temporary_and_result_keeps_source_link(self):
        cover_bytes = []

        async def page(_url):
            return {
                "title": "页面标题",
                "post_title": "页面标题",
                "post_description": "#话题[话题]#",
                "engagement": {"likes": "99", "collects": "8", "comments": "7"},
                "topics": ["话题"],
                "images": [
                    "https://picasso-static.xiaohongshu.com/site-logo.png",
                    "https://sns-webpic-qc.xhscdn.com/spectrum/platform-cover!nd_dft_wlteh_webp_3",
                ],
                "account": {
                    "name": "页面作者",
                    "profile_url": "https://www.xiaohongshu.com/user/profile/u1",
                },
            }

        async def account(_url, _platform, seed):
            return {**app_module.empty_account(), **seed, "follower_count": "123"}

        def download(_url, output_dir, metadata=None):
            path = Path(output_dir) / "temporary.mp4"
            path.write_bytes(b"temporary-video")
            return {"video_path": str(path)}

        def platform_cover(url, output_dir, _referer):
            self.assertIn("platform-cover!nd_dft_", url)
            path = Path(output_dir) / "video_cover.webp"
            Image.new("RGB", (24, 36), (32, 96, 160)).save(path, "WEBP", quality=92)
            cover_bytes.append(path.read_bytes())
            return str(path)

        with TemporaryDirectory() as root:
            with (
                patch.object(app_module, "OUTPUT_DIR", Path(root)),
                patch.object(app_module, "db", _FakeDB()),
                patch.object(app_module, "detect_platform", return_value="xiaohongshu"),
                patch.object(app_module, "extract_video_metadata", return_value={
                    "title": "下载器标题", "description": "#话题[话题]#",
                    "tags": ["话题"], "duration": 65.2, "width": 1080, "height": 1920,
                    "filesize": 42, "format": "HD", "vcodec": "h264",
                    "webpage_url": "https://www.xiaohongshu.com/discovery/item/n1",
                    "uploader_id": "u1", "thumbnail": "https://img/cover.webp",
                }),
                patch.object(app_module, "extract_page", side_effect=page),
                patch.object(app_module, "download_video_cover", side_effect=platform_cover),
                patch.object(app_module, "extract_cover_title_from_path", return_value={
                    "text": "视频封面标题", "confidence": 0.96,
                }),
                patch.object(app_module, "download_video", side_effect=download),
                patch.object(app_module, "transcribe_video_with_model", return_value={
                    "text": "[00:01] 画面文字", "status": "ok",
                    "method": "openrouter_video", "model": "stealth/ox-alpha",
                    "chunks_total": 2, "chunks_succeeded": 2,
                    "chunk_seconds": 60, "overlap_seconds": 2,
                    "fps": 4, "message": "",
                }),
                patch.object(app_module, "extract_video_text", return_value="兜底文字"),
                patch.object(app_module, "hydrate_account", side_effect=account),
                patch.object(app_module, "extract_hot_comments", side_effect=self._comments),
                patch.object(
                    app_module,
                    "analyze_content_with_audit",
                    return_value=_analysis_with_audit({"status": "ok"}),
                ),
            ):
                app_module._run_pipeline("task-1", "https://example.com/video")
                task_dir = Path(root) / "task-1"
                content = json.loads((task_dir / "content.json").read_text(encoding="utf-8"))
            self.assertFalse((task_dir / "_working_media").exists())

        self.assertTrue(content["storage"]["temporary_media_deleted"])
        self.assertFalse(content["storage"]["local_media_retained"])
        self.assertEqual(16, content["schema_version"])
        self.assertEqual("https://www.xiaohongshu.com/discovery/item/n1", content["media_assets"]["video"]["source_url"])
        self.assertEqual(65.2, content["media_assets"]["video"]["duration_seconds"])
        self.assertEqual("页面作者", content["account"]["name"])
        self.assertEqual("99", content["engagement"]["likes"])
        self.assertEqual(["话题"], content["topics"])
        self.assertEqual("", content["post_description"])
        self.assertEqual("视频封面标题", content["cover_title"])
        self.assertEqual("platform_video_cover", content["cover_title_meta"]["source"])
        cover_data_url = content["media_assets"]["video"]["cover_image_b64"]
        self.assertTrue(cover_data_url.startswith("data:image/webp;base64,"))
        self.assertEqual(cover_bytes[0], base64.b64decode(cover_data_url.split(",", 1)[1]))
        self.assertEqual(
            "platform_video_cover",
            content["media_assets"]["video"]["cover_image_source"],
        )
        self.assertIn(
            "platform-cover!nd_dft_",
            content["media_assets"]["video"]["cover_image_url"],
        )
        self.assertEqual("[00:01] 画面文字", content["video_text"])
        self.assertEqual("", content["audio_text"])
        self.assertEqual("openrouter_video", content["video_text_meta"]["method"])
        self.assertEqual("stealth/ox-alpha", content["video_text_meta"]["model"])


if __name__ == "__main__":
    unittest.main()
