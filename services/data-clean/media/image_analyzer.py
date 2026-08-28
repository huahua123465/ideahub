"""VLM: analyze scene grid image in a single call"""
import base64
import os
from openai import OpenAI
from config import OPENAI_API_KEY, OPENAI_BASE_URL, MODEL_VLM


GRID_PROMPT = """These are chronological key frames from one short video, ordered left-to-right and top-to-bottom.

Analyze only what is visually supported. In Chinese, reconstruct the event sequence and emotional arc. For every useful frame, record:
- who is present and how the same person can be recognized across frames;
- facial expression, gaze direction, mouth shape, posture, hand gesture, movement, distance, and interaction;
- visible objects, setting, lighting, and meaningful changes from the previous frame;
- likely emotional state, clearly marked as an inference when uncertain.

Pay special attention to restrained warmth: hesitation, softened eyes, a held-back smile, concern, embarrassment, relief, and small acts of care. Do not invent names, dialogue, relationships, backstory, or events that are not visible. End with a concise chronological summary of the video's beginning, turning point, and ending. This report will be evidence for a faithful novel adaptation."""


def analyze_grid(grid_path: str) -> str:
    """Analyze a scene grid image in a single VLM call"""

    print("  VLM analyzing scene grid (1 call)...")

    ext = os.path.splitext(grid_path)[1].lower()
    mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png"

    with open(grid_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    try:
        client = OpenAI(api_key=OPENAI_API_KEY, base_url=OPENAI_BASE_URL)
        resp = client.chat.completions.create(
            model=MODEL_VLM,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}", "detail": "low"}},
                    {"type": "text", "text": GRID_PROMPT},
                ]
            }],
            max_tokens=2500, temperature=0.5,
        )
        result = resp.choices[0].message.content or ""
        print(f"  VLM response: {len(result)} chars")
        return result

    except Exception as e:
        print(f"  VLM failed (provider may not support vision): {e}")
        return "[Scene grid analysis unavailable - provider does not support vision]"
