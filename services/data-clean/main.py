"""
Video -> AI Animation Storyboard Converter

Tech stack:
  yt-dlp          +178k stars  video download
  OpenAI Vision   GPT-4o       frame -> visual description
  OpenAI Whisper  +105k stars  speech -> text
  OpenAI LLM      GPT-4o       character creation + storyboard generation

Usage:
  python main.py <video_url>
  python main.py <video_url> --no-audio
  python main.py --list
  python main.py --regen <id>
  python main.py --status <id>

Env: OPENAI_API_KEY in .env file
"""
import sys
import json
import os
from pathlib import Path

from config import OUTPUT_DIR, FRAME_INTERVAL, MAX_FRAMES
from db import TaskDB
from utils import url_to_id, detect_platform
from security import public_error_message, redact_sensitive_text, redact_url
from media import download_video, extract_frames, describe_frames, extract_audio, transcribe
from generators import create_characters, generate


def run_pipeline(video_url: str, *, analyze_audio: bool = True,
                 frame_interval: int = FRAME_INTERVAL,
                 max_frames: int = MAX_FRAMES):
    """Core pipeline: video URL -> storyboard script (Markdown + JSON)"""
    vid = url_to_id(video_url)
    source = detect_platform(video_url)
    db = TaskDB()

    print("=" * 60)
    print(f"  Video -> AI Animation Storyboard  [{vid}]")
    print(f"  Source: {source} | {redact_url(video_url)[:100]}")
    print("=" * 60)

    task_dir = OUTPUT_DIR / vid
    task_dir.mkdir(parents=True, exist_ok=True)
    frames_dir = task_dir / "frames"
    frames_dir.mkdir(exist_ok=True)

    # ---- Step 1: Download ----
    db.create_task(vid, video_url, source)
    db.update_status(vid, "downloading")
    print("\n[1/4] Downloading video...")

    try:
        meta = download_video(video_url, str(task_dir))
        if not meta:
            db.update_status(vid, "failed", error_msg="download failed")
            return None
    except Exception as e:
        db.update_status(
            vid,
            "failed",
            error_msg=public_error_message(e, fallback="视频处理失败，请稍后重试"),
        )
        raise

    db.update_status(vid, "downloaded",
                     title=meta["title"], description=meta["description"],
                     duration_sec=meta["duration"])
    db.add_artifact(vid, "video", meta["video_path"])

    title = meta["title"]
    description = meta["description"]
    duration = meta["duration"]

    # ---- Step 2: Analyze ----
    db.update_status(vid, "analyzing")
    print(f"\n[2/4] Analyzing video content...")
    print(f"  Title: {title}")
    print(f"  Duration: {duration:.0f}s")

    frames = extract_frames(meta["video_path"], str(frames_dir),
                            interval=frame_interval, max_frames=max_frames)
    for fp in frames:
        db.add_artifact(vid, "frame", fp)

    frame_descriptions = describe_frames(frames, interval=frame_interval) if frames else []

    transcript = ""
    if analyze_audio:
        audio_path = extract_audio(meta["video_path"], str(task_dir))
        if audio_path:
            db.add_artifact(vid, "audio", audio_path)
            transcript = transcribe(audio_path)

    analysis = {
        "title": title, "description": description,
        "duration_sec": duration,
        "frame_descriptions": frame_descriptions,
        "transcript": transcript,
    }
    analysis_path = task_dir / "analysis.json"
    with open(analysis_path, "w", encoding="utf-8") as f:
        json.dump(analysis, f, ensure_ascii=False, indent=2)
    db.add_artifact(vid, "analysis", str(analysis_path))

    # ---- Step 3: Characters ----
    print(f"\n[3/4] Creating characters...")
    content_summary = "\n".join([
        f"[{fd.get('timestamp_sec',0):.0f}s] {fd.get('description','')[:200]}"
        for fd in frame_descriptions[:10]
    ])
    characters = create_characters(title, description, content_summary)
    if characters:
        db.save_characters(vid, characters)

    # ---- Step 4: Storyboard ----
    print(f"\n[4/4] Generating storyboard...")
    db.update_status(vid, "generating")

    markdown, json_data = generate(
        title=title, description=description, duration_sec=duration,
        source_url=video_url, characters=characters,
        frame_descriptions=frame_descriptions, transcript=transcript,
    )

    json_data["meta"]["source_url"] = video_url
    json_data["meta"]["source_platform"] = source
    json_data["meta"]["original_duration_sec"] = duration

    md_path = task_dir / "script.md"
    json_path = task_dir / "script.json"
    with open(md_path, "w", encoding="utf-8") as f: f.write(markdown)
    with open(json_path, "w", encoding="utf-8") as f: json.dump(json_data, f, ensure_ascii=False, indent=2)

    db.add_artifact(vid, "script_md", str(md_path))
    db.add_artifact(vid, "script_json", str(json_path))
    version = db.add_script(vid, str(md_path), str(json_path))
    db.update_status(vid, "done")

    print(f"\n{'='*60}")
    print(f"  Done! v{version}")
    print(f"  Markdown: {md_path.name}")
    print(f"  JSON:     {json_path.name}")
    print("  Output:   task output directory")
    print(f"{'='*60}")

    preview = redact_sensitive_text(markdown[:800], max_length=800)
    print(f"\n{preview}")
    if len(markdown) > 800:
        print(f"\n... ({len(markdown)} chars total)")

    return {"markdown": markdown, "json": json_data, "version": version}


# =============================================
# CLI
# =============================================
def main():
    import argparse as ap

    p = ap.ArgumentParser(
        description="Video -> AI Animation Storyboard Converter",
        formatter_class=ap.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python main.py https://www.bilibili.com/video/av114550871498587/
  python main.py https://www.bilibili.com/video/av114550871498587/ --no-audio
  python main.py --list
  python main.py --regen abc123def456
  Env: OPENAI_API_KEY (set in .env file)
        """
    )
    p.add_argument("url", nargs="?", help="Video URL")
    p.add_argument("--no-audio", action="store_true", help="Skip audio analysis")
    p.add_argument("--frames", nargs=2, type=int, metavar=("INTERVAL", "MAX"),
                   help="Frame extraction: interval_sec max_count (default: 5 20)")
    p.add_argument("--list", action="store_true", help="List history")
    p.add_argument("--status", metavar="ID", help="Show task detail")
    p.add_argument("--regen", metavar="ID", help="Regenerate storyboard")
    args = p.parse_args()

    db = TaskDB()

    if args.list:
        tasks = db.list_tasks()
        if not tasks:
            print("No history")
            return
        print(f"{'ID':<14} {'Source':<12} {'Title':<40} {'Status':<12} {'Time'}")
        print("-" * 100)
        for t in tasks:
            print(f"{t['id']:<14} {(t['source'] or ''):<12} {(t['title'] or '')[:38]:<40} {t['status']:<12} {t['created_at']}")
        return

    if args.status:
        t = db.get_task(args.status)
        if not t:
            print(f"Task not found: {args.status}")
            return
        print(json.dumps(t, ensure_ascii=False, indent=2, default=str))
        chars = db.get_characters(args.status)
        if chars:
            print(f"\nCharacters ({len(chars)}):")
            for c in chars:
                print(f"  {c['name']} - {c.get('role','')} ({c.get('gender','')}, {c.get('age','')})")
        return

    if args.regen:
        t = db.get_task(args.regen)
        if not t:
            print(f"Task not found: {args.regen}")
            return
        print(f"Regenerating storyboard for: {t['title']}")
        # TODO: regen from saved analysis
        return

    if not args.url:
        p.print_help()
        return

    fi, mf = FRAME_INTERVAL, MAX_FRAMES
    if args.frames:
        fi, mf = args.frames

    run_pipeline(args.url, analyze_audio=not args.no_audio,
                 frame_interval=fi, max_frames=mf)


if __name__ == "__main__":
    main()
