import json
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from media.downloader import (
    _cookie_args, _metadata_from_payload, download_video,
    extract_video_metadata, url_declares_video,
)


class VideoMetadataTests(unittest.TestCase):
    def test_metadata_keeps_platform_id_and_publish_time(self):
        metadata = _metadata_from_payload({
            "id": "note-2026",
            "timestamp": 1787971200,
            "title": "示例作品",
        }, "https://www.xiaohongshu.com/explore/note-2026")

        self.assertEqual("note-2026", metadata["id"])
        self.assertTrue(metadata["published_at"].startswith("2026-"))

    def test_public_mode_never_passes_cookie_file_to_downloader(self):
        self.assertEqual([], _cookie_args(
            "https://www.xiaohongshu.com/explore/note-id", use_login=False,
        ))

    def test_explicit_video_signals_survive_a_metadata_miss(self):
        self.assertTrue(url_declares_video("https://www.xiaohongshu.com/discovery/item/n1?type=video"))
        self.assertTrue(url_declares_video("https://www.douyin.com/video/123456"))
        self.assertFalse(url_declares_video("https://www.xiaohongshu.com/discovery/item/n1?type=normal"))

    def test_metadata_probe_retries_before_returning_unavailable(self):
        failed = subprocess.CompletedProcess(["yt-dlp"], 1, stdout="", stderr="temporary")
        succeeded = subprocess.CompletedProcess(
            ["yt-dlp"],
            0,
            stdout=json.dumps({
                "id": "note-1",
                "title": "视频标题",
                "duration": 12.5,
                "width": 1080,
                "height": 1920,
            }),
            stderr="",
        )
        with (
            patch("media.downloader.validate_public_url"),
            patch("media.downloader.subprocess.run", side_effect=[failed, succeeded]) as run,
            patch("media.downloader.time.sleep") as sleep,
        ):
            metadata = extract_video_metadata("https://example.com/video/1", attempts=3)

        self.assertEqual("note-1", metadata["id"])
        self.assertEqual(12.5, metadata["duration"])
        self.assertEqual(2, run.call_count)
        sleep.assert_called_once_with(0.75)

    def test_downloaded_video_over_duration_is_deleted_after_ffprobe(self):
        with TemporaryDirectory() as root:
            video = Path(root) / "download.mp4"
            video.write_bytes(b"video")
            with (
                patch("media.downloader.validate_public_url"),
                patch("media.downloader.subprocess.run"),
                patch("media.downloader._probe_downloaded_duration", return_value=601.0),
                patch("media.downloader.MAX_VIDEO_DURATION", 600),
            ):
                with self.assertRaises(ValueError):
                    download_video(
                        "https://www.douyin.com/video/1", root,
                        metadata={"title": "ok", "duration": 0},
                    )
            self.assertFalse(video.exists())


if __name__ == "__main__":
    unittest.main()
