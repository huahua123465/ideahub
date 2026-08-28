"""ffmpeg scene detection + thumbnail grid (zero token waste)"""
import os
import subprocess
from pathlib import Path

import cv2
from PIL import Image


def extract_scene_grid(video_path: str, output_dir: str,
                       threshold: float = 0.3, max_scenes: int = 12,
                       cols: int = 4) -> str | None:
    """Detect scene changes via ffmpeg scdet, create thumbnail grid, return grid path"""

    print(f"  Scene detection (threshold={threshold}, max={max_scenes})...")
    os.makedirs(output_dir, exist_ok=True)

    # Step 1: Extract scene-change frames using ffmpeg's scdet filter
    scene_dir = os.path.join(output_dir, "scenes")
    os.makedirs(scene_dir, exist_ok=True)

    # ffmpeg scene detection: only output frames when scene changes > threshold
    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-vf", f"select='gt(scene\\,{threshold})',scale=320:180",
        "-vsync", "vfr",
        "-frames:v", str(max_scenes),
        "-loglevel", "error",
        os.path.join(scene_dir, "scene_%03d.jpg")
    ]
    subprocess.run(cmd, check=True, capture_output=True, timeout=120)

    # Get extracted scene frames
    scene_files = sorted([
        f for f in os.listdir(scene_dir) if f.endswith(".jpg")
    ])
    if not scene_files:
        print("  No scene changes detected, falling back to fixed interval")
        return _fallback_grid(video_path, output_dir, max_scenes, cols)

    scene_paths = [os.path.join(scene_dir, f) for f in scene_files[:max_scenes]]
    print(f"  Detected {len(scene_paths)} scene changes")

    # Step 2: Create thumbnail grid with Pillow
    grid_path = _create_grid(scene_paths, cols, output_dir)
    print(f"  Grid created: {len(scene_paths)} frames -> 1 image")
    return grid_path


def _create_grid(frame_paths: list[str], cols: int, output_dir: str) -> str:
    """Create a thumbnail grid from frame paths"""
    if not frame_paths:
        return ""

    images = [Image.open(p) for p in frame_paths]
    thumb_w, thumb_h = 320, 180

    # Resize all to same size
    images = [img.resize((thumb_w, thumb_h), Image.LANCZOS) for img in images]

    rows = (len(images) + cols - 1) // cols
    grid_w = cols * thumb_w
    grid_h = rows * thumb_h

    grid = Image.new("RGB", (grid_w, grid_h), (30, 30, 30))

    for i, img in enumerate(images):
        r, c = divmod(i, cols)
        grid.paste(img, (c * thumb_w, r * thumb_h))

    # Add frame number labels
    from PIL import ImageDraw, ImageFont
    draw = ImageDraw.Draw(grid)
    for i in range(len(images)):
        r, c = divmod(i, cols)
        draw.text((c * thumb_w + 4, r * thumb_h + 4), f"#{i+1}",
                  fill=(255, 255, 0))

    grid_path = os.path.join(output_dir, "scene_grid.jpg")
    grid.save(grid_path, quality=90)
    return grid_path


def _fallback_grid(video_path: str, output_dir: str,
                   max_frames: int, cols: int) -> str | None:
    """Fallback: extract frames at even intervals"""
    duration = _get_duration(video_path)
    if duration <= 0:
        return None

    frames = min(max_frames, int(duration / 5))
    scene_dir = os.path.join(output_dir, "scenes")
    os.makedirs(scene_dir, exist_ok=True)

    for i in range(frames):
        t = (i + 0.5) * (duration / frames)
        cmd = [
            "ffmpeg", "-y", "-ss", str(t), "-i", video_path,
            "-vframes", "1", "-q:v", "3",
            "-loglevel", "error",
            os.path.join(scene_dir, f"fallback_{i:03d}.jpg")
        ]
        subprocess.run(cmd, check=True, capture_output=True, timeout=20)

    paths = sorted([
        os.path.join(scene_dir, f)
        for f in os.listdir(scene_dir) if f.endswith(".jpg")
    ])
    return _create_grid(paths[:max_frames], cols, output_dir) if paths else None


def _get_duration(video_path: str) -> float:
    cmd = [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        video_path
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        return float(result.stdout.strip()) if result.stdout.strip() else 0.0
    except Exception:
        return 0.0
