import unittest
from io import BytesIO
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

from media.text_ocr import detect_cover_title, download_post_images, reconcile_cover_title


def line(text, y, height, width=500, x=60, confidence=0.99):
    return {
        "text": text,
        "confidence": confidence,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
    }


class CoverTitleTests(unittest.TestCase):
    def test_extensionless_cdn_image_is_accepted_after_pillow_validation(self):
        buffer = BytesIO()
        Image.new("RGB", (720, 960), "white").save(buffer, format="PNG")
        payload = buffer.getvalue()
        diagnostics = {}

        with TemporaryDirectory() as root, patch(
            "media.text_ocr.fetch_safe_bytes",
            return_value=(payload, {"content-type": "application/octet-stream"}, "https://xhscdn.com/image-id"),
        ):
            images = download_post_images(
                ["https://xhscdn.com/image-id"], root,
                "https://www.xiaohongshu.com/explore/note-id",
                diagnostics=diagnostics,
            )

        self.assertEqual(1, len(images))
        self.assertEqual(1, diagnostics["downloaded"])
        self.assertEqual(0, diagnostics["failed"])

    def test_largest_adjacent_lines_become_cover_title(self):
        lines = [
            line("备忘录", 57, 52, 156, 99),
            line("《大哥群体", 223, 120, 509, 93, 0.996),
            line("共性分析》", 353, 113, 501, 59, 0.998),
            line("全文7694字｜阅读需25分钟", 512, 39, 425),
            line("灰产哥", 698, 66, 179),
        ] + [line(f"正文第{i}行", 900 + i * 55, 40, 930) for i in range(8)]

        result = detect_cover_title(lines, 1080, 1800)

        self.assertEqual("《大哥群体共性分析》", result["text"])
        self.assertEqual(2, result["line_count"])
        self.assertGreater(result["font_ratio"], 2.5)
        self.assertAlmostEqual(0.997, result["confidence"], places=3)

    def test_uniform_body_text_does_not_invent_title(self):
        lines = [line(f"正文第{i}行", 180 + i * 55, 40, 900) for i in range(12)]
        self.assertEqual({}, detect_cover_title(lines, 1080, 1800))

    def test_sparse_cover_does_not_raise_threshold_above_largest_text(self):
        lines = [
            line("(Sun.)", 33, 52, 137, 52),
            line("七月二十六日", 42, 39, 194, 833),
            line("不会借力是一种", 548, 120, 819, 127, 0.999),
            line("隐蔽的自恋", 743, 114, 580, 135, 0.999),
        ]

        result = detect_cover_title(lines, 1080, 1440)

        self.assertEqual("不会借力是一种隐蔽的自恋", result["text"])
        self.assertEqual(2, result["line_count"])

    def test_video_cover_keeps_smaller_first_line_of_two_line_title(self):
        lines = [
            line("女孩子无趣的本质", 338, 90, 697, 195, 0.998),
            line("是生命力的匮乏", 423, 169, 874, 196, 0.93),
        ]

        result = detect_cover_title(lines, 1263, 1685)

        self.assertEqual("女孩子无趣的本质是生命力的匮乏", result["text"])
        self.assertEqual(2, result["line_count"])

    def test_low_confidence_cover_line_can_be_corrected_by_close_post_title(self):
        result = {
            "text": "女孩子无趣的本质生命力的贵乏",
            "lines": [
                {"text": "女孩子无趣的本质", "confidence": 0.998},
                {"text": "生命力的贵乏", "confidence": 0.88},
            ],
        }

        corrected = reconcile_cover_title(result, "女孩子无聊的本质是生命力的匮乏")

        self.assertEqual("女孩子无趣的本质是生命力的匮乏", corrected["text"])
        self.assertTrue(corrected["reference_corrected"])


if __name__ == "__main__":
    unittest.main()
