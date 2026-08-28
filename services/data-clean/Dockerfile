FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    ORT_NUM_THREADS=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg curl fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

COPY . /app
RUN groupadd --gid 10001 collector \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin collector \
    && mkdir -p /var/lib/collector/state /var/lib/collector/output \
    && chown -R collector:collector /app /var/lib/collector /ms-playwright

USER 10001:10001
EXPOSE 5000
ENTRYPOINT ["/bin/sh", "/app/docker-entrypoint.sh"]
