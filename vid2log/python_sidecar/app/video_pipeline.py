"""
The core "process one video" job — the offline-desktop counterpart of
backend/app/services/video_pipeline.py. The classification logic (hysteresis,
confidence floor, post-hoc despike — see the module docstring in the cloud
version for the full rationale) is copied verbatim; only the storage layer
changed:

    cloud version: Cloud Storage (download) -> classify -> Firestore (write) -> Cloud Storage (delete)
    this version:  local disk (already there) -> classify -> SQLite (write)

There's no download/delete dance here because there's nothing to move — the
video is already a real file on the user's own disk (Flutter's file picker
handed the sidecar a real path), and it's never copied or duplicated.

Runs on a single-worker background thread pool (see `submit_job` /
JOB_EXECUTOR below) instead of an RQ worker — there's no Redis, and a local
desktop app processing one user's videos doesn't need a distributed queue,
just something that keeps the FastAPI event loop responsive while a job
runs.
"""
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import cv2
from PIL import Image

from app.db import get_job, update_job
from app.ml.classifier import get_hybrid_classifier
from app.ml.hybrid_classifier import HybridClassifier
from app.utils import format_timedelta

log = logging.getLogger(__name__)

# Same tuned constants as the cloud backend — see
# backend/app/services/video_pipeline.py's module docstring for the full
# derivation (measured against a manually-corrected real log).
HYSTERESIS_FRAMES = 2
MIN_SWITCH_CONFIDENCE = 0.5
MIN_SCENE_DURATION_S = 2.0

# One worker: jobs run strictly one-at-a-time, mirroring "the user is
# processing their own videos on their own laptop" rather than the cloud
# backend's "many users, many parallel RQ workers" scaling story — which
# doesn't apply here at all. Raise this only if CPU headroom is confirmed to
# allow it; TensorFlow inference is already using whatever cores it can.
JOB_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vid2log-job")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def submit_job(job_id: str) -> None:
    JOB_EXECUTOR.submit(process_job, job_id)


def submit_training_job(training_job_id: str) -> None:
    """Training runs on the SAME single-worker executor as video jobs, on
    purpose: both are CPU/TensorFlow-heavy, and a laptop running a training
    run and a video job concurrently would just make both slower while
    competing for the same cores. Queuing them behind one worker keeps each
    one fast and keeps memory predictable.

    Imported inside the function rather than at module level to avoid a
    circular import — training_pipeline imports nothing from here, but
    app/main.py imports both, and keeping this lazy means neither module
    has to care about the other's import order."""
    from app.training_pipeline import run_training_job

    JOB_EXECUTOR.submit(run_training_job, training_job_id)


def submit_discovery_job(discovery_job_id: str) -> None:
    """Action discovery shares the same single worker for the same reason
    training does — see submit_training_job above."""
    from app.action_discovery import run_discovery_job

    JOB_EXECUTOR.submit(run_discovery_job, discovery_job_id)


def _sample_and_classify(video_path: Path, hybrid: HybridClassifier, fps: int = 2) -> list:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError(f"Could not open video file: {video_path}")

    video_fps = cap.get(cv2.CAP_PROP_FPS) or fps
    frame_interval = max(1, int(video_fps // fps))

    scenes = []
    current_class = None
    start_time = 0.0
    frame_count = 0
    timestamp = 0.0
    last_confidence = 0.0
    last_source = "cnn"
    ocr_calls = 0

    # Hysteresis state — see HYSTERESIS_FRAMES above.
    candidate_class = None
    candidate_streak = 0

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        frame_count += 1
        if frame_count % frame_interval != 0:
            continue

        timestamp = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000

        try:
            # ORIGINAL-resolution frame — OCR needs this, not the 224x224
            # version the CNN resizes it down to internally.
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = Image.fromarray(frame_rgb).convert("RGB")

            cnn_label, cnn_confidence, cnn_probs = hybrid.classify_frame(image)

            if cnn_label == current_class:
                candidate_class = None
                candidate_streak = 0
                last_confidence = cnn_confidence
                last_source = "cnn"
                continue

            if cnn_label == candidate_class:
                candidate_streak += 1
            else:
                candidate_class = cnn_label
                candidate_streak = 1

            if candidate_streak < HYSTERESIS_FRAMES:
                continue

            final_label, final_confidence, meta = hybrid.verify_transition(
                image, cnn_label, cnn_confidence, cnn_probs
            )
            ocr_calls += 1

            if final_label == current_class:
                last_confidence = final_confidence
                last_source = meta.get("source", "cnn")
            elif final_confidence >= MIN_SWITCH_CONFIDENCE:
                if current_class is not None:
                    scenes.append(
                        {
                            "start": start_time,
                            "end": timestamp,
                            "duration": timestamp - start_time,
                            "class": current_class,
                            "confidence": last_confidence,
                            "source": last_source,
                        }
                    )
                current_class = final_label
                start_time = timestamp
                last_confidence = final_confidence
                last_source = meta.get("source", "cnn")
            # else: near-tie below MIN_SWITCH_CONFIDENCE — stay in current_class.

            candidate_class = None
            candidate_streak = 0

        except Exception as e:
            log.error("Error classifying frame at t=%.2fs: %s", timestamp, e)
            continue

    if current_class is not None:
        scenes.append(
            {
                "start": start_time,
                "end": timestamp,
                "duration": timestamp - start_time,
                "class": current_class,
                "confidence": last_confidence,
                "source": last_source,
            }
        )

    cap.release()
    log.info("OCR verification ran %d time(s) (only at confirmed candidate scene changes).", ocr_calls)
    return _merge_short_scenes(scenes)


def _merge_short_scenes(scenes: list, min_duration_s: float = MIN_SCENE_DURATION_S) -> list:
    """Post-hoc despike pass — see backend/app/services/video_pipeline.py's
    docstring for the full rationale. Verbatim port."""
    if len(scenes) < 3:
        return scenes

    merged = [dict(s) for s in scenes]
    changed = True
    while changed and len(merged) >= 3:
        changed = False
        for i in range(1, len(merged) - 1):
            spike, prev_s, next_s = merged[i], merged[i - 1], merged[i + 1]
            if spike["duration"] < min_duration_s and prev_s["class"] == next_s["class"]:
                prev_s["end"] = next_s["end"]
                prev_s["duration"] = prev_s["end"] - prev_s["start"]
                prev_s["confidence"] = next_s["confidence"]
                prev_s["source"] = next_s["source"]
                del merged[i : i + 2]
                changed = True
                break
    return merged


def _scenes_to_rows(scenes: list) -> list:
    return [
        {
            "start_time": format_timedelta(s["start"]),
            "end_time": format_timedelta(s["end"]),
            "duration": format_timedelta(s["duration"]),
            "action": s["class"],
            "confidence": s["confidence"],
            "source": s.get("source", "cnn"),
        }
        for s in scenes
    ]


def process_job(job_id: str) -> None:
    """Entry point run on JOB_EXECUTOR (see submit_job above)."""
    job = get_job(job_id)
    if job is None:
        log.error("Job %s not found in the local database.", job_id)
        return

    try:
        update_job(job_id, {"status": "processing", "started_at": _now_iso(), "completed_at": None, "error": None})

        video_path = Path(job["video_path"])
        if not video_path.exists():
            raise FileNotFoundError(f"Video file not found: {video_path}")

        # "__default__" (app/main.py's DEFAULT_MODEL_ID) is the UI-facing id
        # for the bundled model; get_hybrid_classifier expresses that same
        # thing as None, since it has no registry entry to look up.
        model_id = job.get("model_id")
        hybrid = get_hybrid_classifier(None if model_id == "__default__" else model_id)

        log.info("[%s] Classifying frames...", job_id)
        t0 = time.time()
        scenes = _sample_and_classify(video_path, hybrid, fps=job.get("fps", 2))
        log.info("[%s] Done in %.1fs — %d scenes.", job_id, time.time() - t0, len(scenes))

        update_job(
            job_id,
            {
                "status": "done",
                "completed_at": _now_iso(),
                "scene_count": len(scenes),
                "scenes": _scenes_to_rows(scenes),
            },
        )

    except Exception as e:
        log.exception("[%s] Processing failed", job_id)
        update_job(job_id, {"status": "failed", "completed_at": _now_iso(), "error": str(e)[:2000]})
