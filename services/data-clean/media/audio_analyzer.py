"""ffmpeg + Whisper: audio extraction and transcription"""
import os
import subprocess
from openai import OpenAI
from config import OPENAI_WHISPER_KEY, OPENAI_WHISPER_URL, MODEL_WHISPER


def extract_audio(video_path: str, output_dir: str) -> str | None:
    print("  extracting audio...")
    audio_path = os.path.join(output_dir, "audio.mp3")
    if os.path.exists(audio_path):
        print("  audio already exists")
        return audio_path

    cmd = [
        "ffmpeg", "-y", "-i", video_path,
        "-vn", "-acodec", "libmp3lame",
        "-ab", "64k", "-ar", "16000", "-ac", "1",
        audio_path
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        if os.path.exists(audio_path) and os.path.getsize(audio_path) > 0:
            print("  audio extracted: audio.mp3")
            return audio_path
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        print(f"  audio extraction failed: {e}")
    return None


def transcribe(audio_path: str) -> str:
    print("  Whisper transcribing...")

    if not OPENAI_WHISPER_KEY:
        print("  skipping: no Whisper API key configured (DeepSeek does not support Whisper)")
        return ""

    file_size_mb = os.path.getsize(audio_path) / (1024 * 1024)
    if file_size_mb > 24:
        print(f"  audio {file_size_mb:.1f}MB > 25MB, trimming to 10min...")
        trimmed = audio_path.replace(".mp3", "_trim.mp3")
        subprocess.run([
            "ffmpeg", "-y", "-i", audio_path,
            "-t", "600", "-acodec", "copy", trimmed
        ], check=True, capture_output=True, timeout=60)
        audio_path = trimmed

    try:
        client = OpenAI(api_key=OPENAI_WHISPER_KEY, base_url=OPENAI_WHISPER_URL)
        with open(audio_path, "rb") as f:
            result = client.audio.transcriptions.create(
                model=MODEL_WHISPER, file=f,
                response_format="text", language="zh",
            )
        text = result if isinstance(result, str) else str(result)
        print(f"  transcription: {len(text)} chars")
        return text
    except Exception as e:
        print(f"  Whisper failed: {e}")
        return ""