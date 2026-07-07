"""Small shared helpers used by both the video and training pipelines."""
import logging
from datetime import timedelta
from pathlib import Path

import requests

log = logging.getLogger(__name__)


def download_file(url: str, dest_path: Path, chunk_size: int = 1024 * 1024) -> Path:
    """Stream a URL to a local file. Used to pull a video (or training image)
    from Cloudinary down to a worker's local disk for processing."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, stream=True, timeout=60) as resp:
        resp.raise_for_status()
        with open(dest_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=chunk_size):
                if chunk:
                    f.write(chunk)
    return dest_path


def format_timedelta(td_seconds: float) -> str:
    """HH:MM:SS formatting, identical to streamlit_application/video_processor.py
    so CSV output stays consistent across both apps during the migration."""
    td = timedelta(seconds=td_seconds)
    total_seconds = int(td.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
