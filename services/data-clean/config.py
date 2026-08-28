"""Global configuration"""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# -- OpenAI-compatible vision/audio provider --
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
MODEL_VLM = os.getenv("MODEL_VLM", "gpt-4o")

# -- Text generation provider (prefer explicit DeepSeek settings) --
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-flash")
LLM_API_KEY = DEEPSEEK_API_KEY or OPENAI_API_KEY
LLM_BASE_URL = DEEPSEEK_BASE_URL if DEEPSEEK_API_KEY else OPENAI_BASE_URL
MODEL_LLM = DEEPSEEK_MODEL if DEEPSEEK_API_KEY else os.getenv("MODEL_LLM", "gpt-4o")

# -- Whisper (OpenAI only, DeepSeek does not offer this) --
OPENAI_WHISPER_KEY = os.getenv("OPENAI_WHISPER_KEY", OPENAI_API_KEY)
OPENAI_WHISPER_URL = os.getenv("OPENAI_WHISPER_URL", "https://api.openai.com/v1")
MODEL_WHISPER = os.getenv("MODEL_WHISPER", "whisper-1")

# -- Native video understanding providers --
# The API key is intentionally read only from the local environment. Never put it
# in source control or browser-delivered configuration.
VIDEO_MODEL_PROVIDER = os.getenv("VIDEO_MODEL_PROVIDER", "moxus").strip().lower()
MOXUS_API_KEY = os.getenv("MOXUS_API_KEY", "")
MOXUS_BASE_URL = os.getenv("MOXUS_BASE_URL", "https://moxus.ai")
MOXUS_VIDEO_MODEL = os.getenv("MOXUS_VIDEO_MODEL", "gemini-3.6-flash")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
OPENROUTER_VIDEO_MODEL = os.getenv("OPENROUTER_VIDEO_MODEL", "stealth/ox-alpha")
VIDEO_MODEL_CHUNK_SECONDS = int(os.getenv("VIDEO_MODEL_CHUNK_SECONDS", "60"))
VIDEO_MODEL_CHUNK_OVERLAP = int(os.getenv("VIDEO_MODEL_CHUNK_OVERLAP", "2"))
VIDEO_MODEL_FPS = int(os.getenv("VIDEO_MODEL_FPS", "4"))
VIDEO_MODEL_WIDTH = int(os.getenv("VIDEO_MODEL_WIDTH", "720"))
VIDEO_MODEL_MAX_CHUNKS = int(os.getenv("VIDEO_MODEL_MAX_CHUNKS", "20"))
VIDEO_MODEL_REQUEST_RETRIES = int(os.getenv("VIDEO_MODEL_REQUEST_RETRIES", "3"))

# -- IdeaHub result handoff --
# Keep the integration key on the server. The browser only calls this app's
# local proxy and never receives the bearer token.
IDEAHUB_API_KEY = os.getenv("IDEAHUB_API_KEY", "").strip()
IDEAHUB_INGEST_URL = os.getenv(
    "IDEAHUB_INGEST_URL",
    "https://xm.xingxingqule.com:9443/api/ingest/analysis",
).strip()
IDEAHUB_DOC_URL = os.getenv(
    "IDEAHUB_DOC_URL",
    "https://xm.xingxingqule.com:9443/%E6%8E%A5%E5%85%A5%E8%AF%B4%E6%98%8E.html",
).strip()

# -- Paths --
ROOT_DIR = Path(__file__).parent
DATA_DIR = ROOT_DIR / "data"
OUTPUT_DIR = ROOT_DIR / "output"
DB_PATH = DATA_DIR / "pipeline.db"

# -- Video processing --
FRAME_INTERVAL = int(os.getenv("FRAME_INTERVAL", "5"))
MAX_FRAMES = int(os.getenv("MAX_FRAMES", "20"))
MAX_VIDEO_DURATION = int(os.getenv("MAX_VIDEO_DURATION", "600"))

# -- Bounded hot-comment extraction --
COMMENT_LIKE_THRESHOLD = int(os.getenv("COMMENT_LIKE_THRESHOLD", "20"))
COMMENT_TOP_K = int(os.getenv("COMMENT_TOP_K", "5"))
COMMENT_MAX_PRIMARY_PAGES = int(os.getenv("COMMENT_MAX_PRIMARY_PAGES", "8"))
COMMENT_MAX_REPLY_THREADS = int(os.getenv("COMMENT_MAX_REPLY_THREADS", "24"))
COMMENT_MAX_REPLY_PAGES = int(os.getenv("COMMENT_MAX_REPLY_PAGES", "3"))
COMMENT_MAX_SCANNED = int(os.getenv("COMMENT_MAX_SCANNED", "320"))
COMMENT_TIMEOUT_SEC = int(os.getenv("COMMENT_TIMEOUT_SEC", "50"))
COMMENT_MIN_CONFIDENCE_SCANNED = int(os.getenv("COMMENT_MIN_CONFIDENCE_SCANNED", "80"))
COMMENT_TARGET_CONFIDENCE = float(os.getenv("COMMENT_TARGET_CONFIDENCE", "0.80"))

for d in [DATA_DIR, OUTPUT_DIR]:
    d.mkdir(parents=True, exist_ok=True)
