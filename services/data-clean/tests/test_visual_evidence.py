import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

from media import visual_evidence


class VisualEvidenceTests(unittest.TestCase):
    def test_image_batches_return_bounded_attributable_observations(self):
        with TemporaryDirectory() as root:
            path = Path(root) / "post.png"
            Image.new("RGB", (1200, 900), (220, 180, 120)).save(path)
            payload = {"items": [{
                "image_index": 1,
                "description": "暖色背景上的居中文字卡片",
                "composition": "主体居中",
                "typography": "大号深色标题",
                "confidence": 1.4,
            }]}
            response = SimpleNamespace(choices=[SimpleNamespace(
                message=SimpleNamespace(content=json.dumps(payload, ensure_ascii=False)))])
            create = unittest.mock.Mock(return_value=response)
            client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
            with (
                patch.object(visual_evidence, "LLM_API_KEY", "test-key"),
                patch.object(visual_evidence, "OpenAI", return_value=client),
            ):
                result = visual_evidence.analyze_images_visual_evidence([{
                    "index": 1, "path": str(path), "source_url": "https://example.test/post.png",
                }])
        self.assertEqual("ok", result["meta"]["status"])
        self.assertEqual(1, result["meta"]["images_succeeded"])
        self.assertEqual("image_vision", result["items"][0]["source_kind"])
        self.assertEqual(1.0, result["items"][0]["confidence"])
        request = create.call_args.kwargs
        self.assertEqual(0, request["temperature"])
        self.assertTrue(any(part.get("type") == "image_url" for part in request["messages"][0]["content"]))

    def test_missing_key_fails_closed_without_model_call(self):
        with patch.object(visual_evidence, "LLM_API_KEY", ""):
            result = visual_evidence.analyze_images_visual_evidence([{"path": "missing.png"}])
        self.assertEqual("empty", result["meta"]["status"])
        self.assertEqual([], result["items"])


if __name__ == "__main__":
    unittest.main()
