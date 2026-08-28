import json
import subprocess
import unittest
from unittest.mock import patch

from media.downloader import extract_video_metadata, url_declares_video


class VideoMetadataTests(unittest.TestCase):
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
            patch("media.downloader.subprocess.run", side_effect=[failed, succeeded]) as run,
            patch("media.downloader.time.sleep") as sleep,
        ):
            metadata = extract_video_metadata("https://example.com/video/1", attempts=3)

        self.assertEqual("note-1", metadata["id"])
        self.assertEqual(12.5, metadata["duration"])
        self.assertEqual(2, run.call_count)
        sleep.assert_called_once_with(0.75)


if __name__ == "__main__":
    unittest.main()
