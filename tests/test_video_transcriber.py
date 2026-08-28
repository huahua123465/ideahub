import unittest
from unittest.mock import patch

from media import video_transcriber


class VideoTranscriberTests(unittest.TestCase):
    def test_chunk_starts_overlap_instead_of_fixed_frame_sampling(self):
        self.assertEqual(
            [0.0, 58.0, 116.0, 174.0],
            video_transcriber._build_chunk_starts(181, 60, 2, 20),
        )

    def test_model_json_is_parsed_with_chunk_offset(self):
        text = '''{"segments":[
            {"start_seconds":1.25,"text":"第一句"},
            {"start":"00:03.5","text":"第二句"}
        ]}'''
        self.assertEqual(
            [
                {"seconds": 11.25, "text": "第一句"},
                {"seconds": 13.5, "text": "第二句"},
            ],
            video_transcriber._parse_model_segments(text, 10),
        )

    def test_model_json_array_is_also_accepted(self):
        text = '''[
            {"start_seconds":0,"text":"第一句"},
            {"start_seconds":1,"text":"第二句"}
        ]'''
        self.assertEqual(2, len(video_transcriber._parse_model_segments(text)))

    def test_overlapping_chunk_duplicates_are_removed(self):
        merged = video_transcriber._merge_segments([
            {"seconds": 58.1, "text": "这是重复字幕"},
            {"seconds": 59.8, "text": "这是重复字幕。"},
            {"seconds": 61.0, "text": "这是下一句"},
        ])
        self.assertEqual(2, len(merged))
        self.assertEqual("这是下一句", merged[1]["text"])

    def test_incremental_caption_text_is_never_removed_as_similar(self):
        merged = video_transcriber._merge_segments([
            {"seconds": 1.0, "text": "女孩子无趣的本质", "chunk_index": 0},
            {"seconds": 1.5, "text": "女孩子无趣的本质是", "chunk_index": 0},
            {"seconds": 2.0, "text": "女孩子无趣的本质是生命力的匮乏", "chunk_index": 0},
        ])
        self.assertEqual(3, len(merged))

    def test_missing_key_is_explicit_and_never_starts_processing(self):
        with (
            patch.object(video_transcriber, "VIDEO_MODEL_PROVIDER", "moxus"),
            patch.object(video_transcriber, "MOXUS_API_KEY", ""),
            patch.object(video_transcriber, "OPENROUTER_API_KEY", ""),
        ):
            result = video_transcriber.transcribe_video_with_model("missing.mp4", "unused")
        self.assertEqual("unavailable", result["status"])
        self.assertEqual("moxus_video", result["method"])
        self.assertIn("MOXUS_API_KEY", result["message"])


if __name__ == "__main__":
    unittest.main()
