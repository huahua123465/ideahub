#!/usr/bin/env bash
set -Eeuo pipefail

# Run this only on the VPS. Commands that may interpolate Compose environment values stay quiet;
# failures report only the validation stage so tokens and API keys never enter terminal/CI logs.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
CURRENT_STEP="initialization"

fail() {
  printf '\nCollector VPS smoke failed: %s\n' "${CURRENT_STEP}" >&2
  exit 1
}

run_quiet() {
  CURRENT_STEP="$1"
  shift
  if ! "$@" >/dev/null 2>&1; then
    fail
  fi
}

cd "${PROJECT_DIR}"

run_quiet "Docker is not installed" command -v docker
run_quiet "Docker Compose is unavailable" docker compose version
run_quiet "docker compose config validation" docker compose config --quiet
run_quiet "Collector image build" docker compose build collector
run_quiet "Collector container startup" docker compose up -d --no-deps collector

CURRENT_STEP="Collector did not become healthy within 90 seconds"
healthy=false
for _attempt in $(seq 1 30); do
  container_id="$(docker compose ps -q collector 2>/dev/null || true)"
  if [[ -n "${container_id}" ]]; then
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}" 2>/dev/null || true)"
    if [[ "${health}" == "healthy" ]]; then
      healthy=true
      break
    fi
  fi
  sleep 3
done
[[ "${healthy}" == "true" ]] || fail

CURRENT_STEP="Collector must not run as root"
uid="$(docker compose exec -T collector id -u 2>/dev/null | tr -d '\r\n')" || fail
[[ "${uid}" =~ ^[0-9]+$ ]] || fail
(( uid != 0 )) || fail

run_quiet "Collector state/output persistence directories are not writable" \
  docker compose exec -T collector sh -c \
  'set -eu; touch /var/lib/collector/state/.vps-smoke-write /var/lib/collector/output/.vps-smoke-write; rm -f /var/lib/collector/state/.vps-smoke-write /var/lib/collector/output/.vps-smoke-write'

run_quiet "Collector /health request" \
  docker compose exec -T collector curl -fsS http://127.0.0.1:5000/health

run_quiet "FFmpeg is unavailable in the Collector container" \
  docker compose exec -T collector ffmpeg -version

CURRENT_STEP="Chromium/Playwright local data page screenshot"
if ! docker compose exec -T collector python - >/dev/null 2>&1 <<'PY'
from pathlib import Path
from playwright.sync_api import sync_playwright

screenshot = Path("/tmp/collector-vps-smoke.png")
try:
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 640, "height": 360})
        page.goto("data:text/html,<title>collector-smoke</title><h1>collector ready</h1>", wait_until="load")
        page.screenshot(path=str(screenshot))
        browser.close()
    if not screenshot.is_file() or screenshot.stat().st_size == 0:
        raise RuntimeError("empty screenshot")
finally:
    screenshot.unlink(missing_ok=True)
PY
then
  fail
fi

printf '\nCollector VPS smoke passed: Compose, build, non-root, persistence, health, FFmpeg and Chromium.\n'
