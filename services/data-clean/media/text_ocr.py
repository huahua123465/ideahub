"""OCR helpers for full video frames and image posts."""
import re
import statistics
from io import BytesIO
from difflib import SequenceMatcher
from pathlib import Path

import cv2
import httpx
from PIL import Image

from config import COLLECTOR_MAX_DOWNLOAD_MB
from security import UnsafeUrl, fetch_safe_bytes

cv2.setNumThreads(1)
from rapidocr_onnxruntime import RapidOCR


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "")).strip(" |丨")


def _similar(text: str, previous: list[str]) -> bool:
    return any(
        text == item or text in item or item in text or SequenceMatcher(None, text, item).ratio() >= 0.88
        for item in previous
    )


def _read_image_lines(ocr: RapidOCR, image) -> list[dict]:
    result, _ = ocr(image)
    lines = []
    for box, text, confidence in result or []:
        text = _clean(text)
        if confidence >= 0.65 and len(text) >= 2:
            xs = [float(point[0]) for point in box]
            ys = [float(point[1]) for point in box]
            lines.append({
                "text": text,
                "confidence": float(confidence),
                "x": min(xs),
                "y": min(ys),
                "width": max(xs) - min(xs),
                "height": max(ys) - min(ys),
            })
    return sorted(lines, key=lambda line: (line["y"], line["x"]))


def _lines_text(lines: list[dict]) -> str:
    return _clean(" ".join(line["text"] for line in lines))


def _read_image(ocr: RapidOCR, image) -> str:
    return _lines_text(_read_image_lines(ocr, image))


_COVER_CHROME_TEXT = {
    "备忘录", "小红书", "关注", "分享", "更多", "编辑", "发布",
}


def _horizontal_match(left: dict, right: dict, image_width: float) -> bool:
    left_end = left["x"] + left["width"]
    right_end = right["x"] + right["width"]
    overlap = max(0.0, min(left_end, right_end) - max(left["x"], right["x"]))
    min_width = max(1.0, min(left["width"], right["width"]))
    left_center = left["x"] + left["width"] / 2
    right_center = right["x"] + right["width"] / 2
    return overlap / min_width >= 0.15 or abs(left_center - right_center) <= image_width * 0.22


def detect_cover_title(lines: list[dict], image_width: int, image_height: int) -> dict:
    """Pick the largest contiguous text block on the first post image.

    Font size is approximated by OCR box height. Conservative thresholds keep
    app chrome, watermarks, and ordinary body headings from becoming titles.
    """
    if not lines or not image_width or not image_height:
        return {}

    eligible = [
        line for line in lines
        if line.get("height", 0) > 0
        and 2 <= len(_clean(line.get("text", ""))) <= 80
        and _clean(line.get("text", "")) not in _COVER_CHROME_TEXT
        and not re.fullmatch(r"[\W_\d]+", _clean(line.get("text", "")))
    ]
    if not eligible:
        return {}

    heights = [line["height"] for line in lines if line.get("height", 0) > 0]
    median_height = statistics.median(heights)
    seed = max(eligible, key=lambda line: line["height"])
    seed_center = seed["y"] + seed["height"] / 2
    font_ratio = seed["height"] / max(1.0, median_height)

    if seed_center < image_height * 0.07 or seed_center > image_height * 0.70:
        return {}
    if font_ratio < 1.55 and seed["height"] < image_height * 0.045:
        return {}

    # Sparse covers may contain only two chrome labels and two title lines. In
    # that case the title itself raises the global median, so never let the
    # median-derived threshold exceed the relative-to-largest threshold.
    min_title_height = max(
        image_height * 0.02,
        min(median_height * 1.45, seed["height"] * 0.50),
    )
    strong = sorted([
        line for line in eligible
        if line["height"] >= min_title_height
        and image_height * 0.07 <= line["y"] + line["height"] / 2 <= image_height * 0.70
    ], key=lambda line: (line["y"], line["x"]))
    if not strong:
        return {}

    clusters: list[list[dict]] = []
    for line in strong:
        if not clusters:
            clusters.append([line])
            continue
        previous = clusters[-1][-1]
        gap = line["y"] - (previous["y"] + previous["height"])
        if gap <= seed["height"] * 0.85 and _horizontal_match(previous, line, image_width):
            clusters[-1].append(line)
        else:
            clusters.append([line])

    cluster = next((items for items in clusters if seed in items), [seed])
    title = "".join(_clean(line["text"]) for line in cluster)
    title = re.sub(r"(?<=[\u3400-\u9fff》」】])\s+(?=[\u3400-\u9fff《「【])", "", title)
    if not 2 <= len(title) <= 100:
        return {}

    return {
        "text": title,
        "confidence": round(sum(line["confidence"] for line in cluster) / len(cluster), 3),
        "font_ratio": round(font_ratio, 2),
        "line_count": len(cluster),
        "lines": [
            {"text": _clean(line["text"]), "confidence": round(line["confidence"], 3)}
            for line in cluster
        ],
        "source_image_index": 1,
    }


def reconcile_cover_title(result: dict, reference_title: str) -> dict:
    """Correct only low-confidence OCR lines using a closely matching post title.

    High-confidence lines remain verbatim so a cover wording difference is not
    silently replaced by post metadata.
    """
    lines = result.get("lines") or []
    reference = _clean(reference_title)
    if len(lines) != 2 or len(reference) < 4:
        return result

    best = None
    for split in range(1, len(reference)):
        segments = (reference[:split], reference[split:])
        ratios = [
            SequenceMatcher(None, _clean(lines[index].get("text", "")), segments[index]).ratio()
            for index in range(2)
        ]
        length_penalty = sum(
            abs(len(_clean(lines[index].get("text", ""))) - len(segments[index]))
            for index in range(2)
        ) * 0.015
        # A high-confidence first line is a reliable boundary signal even when
        # the reference contains a one-character bridge at the next line.
        boundary_penalty = abs(
            len(_clean(lines[0].get("text", ""))) - len(segments[0])
        ) * 0.03
        score = sum(ratios) / 2 - length_penalty - boundary_penalty
        if best is None or score > best[0]:
            best = (score, segments, ratios)

    if not best or best[0] < 0.70:
        return result
    _, segments, ratios = best
    corrected = []
    used_reference = False
    for index, line in enumerate(lines):
        text = _clean(line.get("text", ""))
        if float(line.get("confidence") or 0) < 0.95 and ratios[index] >= 0.70:
            text = segments[index]
            used_reference = True
        corrected.append(text)
    if not used_reference:
        return result
    return {
        **result,
        "text": "".join(corrected),
        "reference_corrected": True,
    }


def extract_cover_title_from_path(image_path: str) -> dict:
    image = cv2.imread(str(image_path))
    if image is None:
        return {}
    lines = _read_image_lines(RapidOCR(), image)
    height, width = image.shape[:2]
    return detect_cover_title(lines, width, height)


def extract_video_text(video_path: str, interval: float = 3.0, max_samples: int = 120) -> str:
    """Sample complete frames so captions, labels, signs, and other visible text are retained."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return ""
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = total_frames / fps if total_frames else 0
    if duration and duration / interval > max_samples:
        interval = duration / max_samples
    step = max(1, round(fps * interval))
    ocr = RapidOCR()
    entries = []
    recent = []
    frame_no = 0
    try:
        while len(entries) < max_samples:
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_no)
            ok, frame = cap.read()
            if not ok:
                break
            text = _read_image(ocr, frame)
            if text and not _similar(text, recent):
                seconds = frame_no / fps
                entries.append((seconds, text))
                recent = (recent + [text])[-6:]
            frame_no += step
            if total_frames and frame_no >= total_frames:
                break
    finally:
        cap.release()
    return "\n".join(f"[{int(sec)//60:02d}:{int(sec)%60:02d}] {text}" for sec, text in entries)


def download_post_images(urls: list[str], output_dir: str, referer: str, limit: int = 20) -> list[dict]:
    image_dir = Path(output_dir) / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    paths = []
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        "Referer": referer,
    }
    for image_url in urls[:limit]:
        try:
            content, response_headers, final_url = fetch_safe_bytes(
                image_url,
                max_bytes=min(COLLECTOR_MAX_DOWNLOAD_MB, 25) * 1024 * 1024,
                headers=headers,
            )
            content_type = response_headers.get("content-type", "")
            if not content_type.startswith("image/") or len(content) < 1024:
                continue
            with Image.open(BytesIO(content)) as image:
                width, height = image.size
            # Social pages also expose logos, avatars, and share banners. Real post
            # images are normally high resolution; do not present page chrome as content.
            if max(width, height) < 800:
                continue
            suffix = ".png" if "png" in content_type else ".webp" if "webp" in content_type else ".jpg"
            path = image_dir / f"image_{len(paths) + 1:02d}{suffix}"
            path.write_bytes(content)
            paths.append({
                "path": str(path),
                "source_url": final_url,
                "width": width,
                "height": height,
                "size_bytes": len(content),
            })
        except (httpx.HTTPError, UnsafeUrl, OSError, ValueError) as exc:
            print(f"  image download failed safely ({exc.__class__.__name__})")
    return paths


def extract_images_text(images: list[dict]) -> list[dict]:
    ocr = RapidOCR()
    results = []
    for index, item in enumerate(images):
        path = item["path"]
        image = cv2.imread(path)
        if image is None:
            results.append({**item, "text": ""})
            continue
        lines = _read_image_lines(ocr, image)
        result = {**item, "text": _lines_text(lines)}
        if index == 0:
            height, width = image.shape[:2]
            result["cover_title"] = detect_cover_title(lines, width, height)
        results.append(result)
    return results
