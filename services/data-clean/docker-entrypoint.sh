#!/bin/sh
set -eu

python - <<'PY'
import os
import sys
token = os.environ.get("COLLECTOR_INTERNAL_TOKEN", "").encode("utf-8")
if len(token) < 32:
    print("Collector refused to start: COLLECTOR_INTERNAL_TOKEN must be at least 32 bytes", file=sys.stderr)
    raise SystemExit(78)
for name in ("COLLECTOR_STATE_DIR", "COLLECTOR_OUTPUT_DIR"):
    path = os.environ.get(name)
    if not path or not os.path.isdir(path) or not os.access(path, os.W_OK):
        print(f"Collector refused to start: {name} is not a writable directory", file=sys.stderr)
        raise SystemExit(78)
PY

exec gunicorn \
  --bind 0.0.0.0:5000 \
  --workers 1 \
  --threads "${COLLECTOR_WEB_THREADS:-4}" \
  --timeout "${COLLECTOR_HTTP_TIMEOUT_SEC:-120}" \
  --graceful-timeout 30 \
  --access-logfile - \
  --error-logfile - \
  app:app
