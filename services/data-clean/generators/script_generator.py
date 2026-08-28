"""Novel generation engine"""
from openai import OpenAI
from config import LLM_API_KEY, LLM_BASE_URL, MODEL_LLM
from generators.templates import NOVEL_SYSTEM, NOVEL_USER


def generate_novel(title: str, description: str,
                   scene_analysis: str, transcript: str,
                   source_text: str) -> str:
    """Generate a novel chapter from video/article content"""

    print("  LLM generating novel...")

    prompt = NOVEL_USER.format(
        title=title,
        description=(description or "(none)")[:1500],
        scene_analysis=scene_analysis[:5000] or "(no visual analysis available)",
        transcript=(transcript or "(no audio transcript)")[:3000],
        source_text=source_text[:6000] or "",
    )

    client = OpenAI(api_key=LLM_API_KEY, base_url=LLM_BASE_URL)
    request_args = dict(
        model=MODEL_LLM,
        messages=[
            {"role": "system", "content": NOVEL_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        max_tokens=4000, temperature=0.8,
    )
    if MODEL_LLM.startswith("deepseek-v4"):
        request_args["extra_body"] = {"thinking": {"type": "disabled"}}
    resp = client.chat.completions.create(**request_args)

    novel = resp.choices[0].message.content or ""
    print(f"  Novel generated: {len(novel)} chars")
    return novel
