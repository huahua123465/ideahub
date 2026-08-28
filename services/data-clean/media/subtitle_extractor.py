"""OCR extraction for subtitles burned into video frames."""
import re
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path

import cv2
from rapidocr_onnxruntime import RapidOCR
from config import COLLECTOR_OCR_WORKERS


def extract_burned_subtitles(video_path: str, interval: float = 4.0) -> str:
    """Sample the caption band and return de-duplicated timed OCR text."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return ""

    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    sample_every = max(1, round(fps * interval))
    samples = []
    frame_no = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_no % sample_every == 0:
                height = frame.shape[0]
                crop = frame[int(height * 0.62):int(height * 0.88), :]
                samples.append((frame_no / fps, crop.copy()))
            frame_no += 1
    finally:
        cap.release()

    if not samples:
        return ""
    worker_count = min(COLLECTOR_OCR_WORKERS, len(samples))
    chunks = [samples[index::worker_count] for index in range(worker_count)]
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        recognized = [item for batch in pool.map(_ocr_chunk, chunks) for item in batch]

    entries: list[tuple[float, str]] = []
    recent: list[str] = []
    for seconds, text in sorted(recognized):
        if text and not _is_duplicate(text, recent):
            entries.append((seconds, text))
            recent = (recent + [text])[-4:]
    return "\n".join(f"[{_format_time(seconds)}] {text}" for seconds, text in entries)


def _ocr_chunk(samples) -> list[tuple[float, str]]:
    ocr = RapidOCR()
    recognized = []
    for seconds, crop in samples:
        result, _ = ocr(crop)
        lines = []
        for box, text, confidence in result or []:
            text = _clean_text(text)
            if confidence >= 0.72 and len(text) >= 2:
                y = min(point[1] for point in box)
                x = min(point[0] for point in box)
                lines.append((y, x, text))
        recognized.append((seconds, _clean_text(" ".join(line[2] for line in sorted(lines)))))
    return recognized


def extract_or_load_subtitles(video_path: str, output_dir: str) -> str:
    """Cache OCR results next to the task artifacts."""
    output_path = Path(output_dir) / "subtitle_ocr.txt"
    if output_path.exists() and output_path.stat().st_size:
        return output_path.read_text(encoding="utf-8")
    text = extract_burned_subtitles(video_path)
    if text:
        output_path.write_text(text, encoding="utf-8")
    return text


def _clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", (text or "")).strip()
    return re.sub(r"^[|\u4e28]+|[|\u4e28]+$", "", text).strip()


def _is_duplicate(text: str, recent: list[str]) -> bool:
    for previous in recent:
        if text == previous or text in previous or previous in text:
            return True
        if SequenceMatcher(None, text, previous).ratio() >= 0.86:
            return True
    return False


def _format_time(seconds: float) -> str:
    total = int(seconds)
    return f"{total // 60:02d}:{total % 60:02d}"
