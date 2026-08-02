FROM python:3.11-slim

# OpenCV needs these system libs even in "headless" mode; tesseract-ocr is
# the actual OCR engine that pytesseract (a thin Python wrapper) calls out to.
# build-essential (gcc/g++/make) is required because hdbscan ships as a
# source distribution with Cython extensions on some platforms/architectures
# (notably linux/arm64, e.g. building this image locally on Apple Silicon) —
# without a compiler, `pip install hdbscan` fails with "gcc: No such file or
# directory". Cloud Run itself only runs linux/amd64 images regardless, so
# building via `gcloud builds submit` (native amd64, prebuilt wheels usually
# available) is preferred over local `docker build` on an ARM Mac — see
# DEPLOYMENT.md, step 5.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PYTHONUNBUFFERED=1
# Local/docker-compose default — Cloud Run overrides this itself by
# injecting its own $PORT (see DEPLOYMENT.md, repo root), which the
# shell-form CMD below picks up automatically.
ENV PORT=8000

# Default: run the API. Override the container command to
# `python -m app.worker` to run this same image as an RQ worker instead
# (see docker-compose.yml, and the Cloud Run worker-pool deploy command in
# DEPLOYMENT.md). Shell form (not exec-array form) so $PORT actually expands —
# Cloud Run always sets this env var itself and expects the container to
# listen on it, so hardcoding a port here would break on Cloud Run.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT}
