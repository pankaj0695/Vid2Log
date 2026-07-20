"""Small shared helpers used by both the video and training pipelines."""
import copy
import logging
from datetime import timedelta
from pathlib import Path
from typing import Optional

import requests

log = logging.getLogger(__name__)

# Sub-keys of a training `metrics` dict that hold one `_evaluate()` result
# (see training_pipeline.py) — i.e. the ones that might contain a
# `confusion_matrix`. `text_only`/`combined` are None when OCR text wasn't
# usable for a given run, so callers must skip those instead of assuming
# all three are always present.
_METRIC_REPORT_KEYS = ("cnn_only", "text_only", "combined")


def metrics_to_firestore(metrics: Optional[dict]) -> Optional[dict]:
    """
    Firestore rejects arrays that directly contain other arrays ("Property
    metrics contains an invalid nested entity") — and `confusion_matrix` is
    exactly that: a `List[List[int]]` from `sklearn.metrics.confusion_matrix(...).tolist()`.
    Firestore IS fine with an array of maps, each map holding an array of
    scalars, so this rewrites every `confusion_matrix: List[List[int]]`
    into `confusion_matrix: [{"row": [...]}, ...]` before writing. Call
    `metrics_from_firestore()` on the way back out to restore the plain
    `number[][]` shape the frontend (`frontend/lib/types.ts`) expects.
    """
    if not metrics:
        return metrics
    safe = copy.deepcopy(metrics)
    for key in _METRIC_REPORT_KEYS:
        report = safe.get(key)
        if isinstance(report, dict) and isinstance(report.get("confusion_matrix"), list):
            report["confusion_matrix"] = [{"row": row} for row in report["confusion_matrix"]]
    return safe


def metrics_from_firestore(metrics: Optional[dict]) -> Optional[dict]:
    """Inverse of metrics_to_firestore() — see its docstring."""
    if not metrics:
        return metrics
    plain = copy.deepcopy(metrics)
    for key in _METRIC_REPORT_KEYS:
        report = plain.get(key)
        if isinstance(report, dict) and isinstance(report.get("confusion_matrix"), list):
            report["confusion_matrix"] = [
                row["row"] if isinstance(row, dict) else row for row in report["confusion_matrix"]
            ]
    return plain


def download_file(url: str, dest_path: Path, chunk_size: int = 1024 * 1024) -> Path:
    """Stream an arbitrary HTTPS URL to a local file. Not currently used by
    the video/training/model pipelines — those read Cloud Storage blobs
    directly via app/services/gcs_service.py (Admin SDK, no public URL
    needed) instead. Kept as a generic utility for any future need to pull
    a file from an external URL."""
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
