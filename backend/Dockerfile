FROM python:3.11-slim

# OpenCV needs these system libs even in "headless" mode; tesseract-ocr is
# the actual OCR engine that pytesseract (a thin Python wrapper) calls out to.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PYTHONUNBUFFERED=1

# Default: run the API. Override the command to `python -m app.worker`
# to run this same image as an RQ worker instead (see docker-compose.yml).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
