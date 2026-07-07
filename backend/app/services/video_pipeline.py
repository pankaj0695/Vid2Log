"""
The core "process one video" job, run inside an RQ worker (see app/worker.py).

Lifecycle of the video itself (this is the whole point of using Cloudinary as
TEMPORARY storage):

    Cloudinary (uploaded by frontend)
        --> downloaded to local /tmp on this worker
        --> classified frame-by-frame, scenes extracted
        --> scenes written to Firestore (the durable output)
        --> local /tmp file deleted (always, even on error)
        --> Cloudinary asset deleted (once the log is safely saved)

At no point does a video get written to any permanent store.
"""
import logging
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
from PIL import Image

from app.ml.classifier import get_classifier
from app.services import cloudinary_service
from app.services.firebase_service import get_db
from app.utils import download_file, format_timedelta

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sample_and_classify(video_path: Path, classify_fn, fps: int = 2) -> list:
    """Same scene-change algorithm as streamlit_application/video_processor.py,
    just parameterized on whichever model's classify_fn is passed in."""
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
    confidence = 0.0

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        frame_count += 1
        if frame_count % frame_interval != 0:
            continue

        timestamp = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000

        try:
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = Image.fromarray(frame_rgb).convert("RGB")
            class_label, confidence = classify_fn(image)

            if class_label != current_class:
                if current_class is not None:
                    scenes.append(
                        {
                            "start": start_time,
                            "end": timestamp,
                            "duration": timestamp - start_time,
                            "class": current_class,
                            "confidence": confidence,
                        }
                    )
                current_class = class_label
                start_time = timestamp
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
                "confidence": confidence,
            }
        )

    cap.release()
    return scenes


def _scenes_to_rows(scenes: list) -> list:
    return [
        {
            "start_time": format_timedelta(s["start"]),
            "end_time": format_timedelta(s["end"]),
            "duration": format_timedelta(s["duration"]),
            "class": s["class"],
            "confidence": s["confidence"],
        }
        for s in scenes
    ]


def process_job(job_id: str) -> None:
    """Entry point called by the RQ worker for `video_processing` jobs."""
    db = get_db()
    job_ref = db.collection("jobs").document(job_id)
    job = job_ref.get()
    if not job.exists:
        log.error("Job %s not found in Firestore.", job_id)
        return

    data = job.to_dict()
    job_ref.update({"status": "processing", "started_at": _now_iso()})

    tmp_dir = Path(tempfile.mkdtemp(prefix=f"vid2log_{job_id}_"))
    cloudinary_public_id = data["cloudinary_public_id"]
    resource_type = data.get("resource_type", "video")

    try:
        video_path = tmp_dir / "video"
        log.info("[%s] Downloading video from Cloudinary...", job_id)
        download_file(data["cloudinary_url"], video_path)

        classify_fn, _class_names = get_classifier(
            model_id=data.get("model_id"),
            cloudinary_model_url=data.get("model_cloudinary_url"),
            labels=data.get("model_labels"),
        )

        log.info("[%s] Classifying frames...", job_id)
        t0 = time.time()
        scenes = _sample_and_classify(video_path, classify_fn, fps=data.get("fps", 2))
        log.info("[%s] Done in %.1fs — %d scenes.", job_id, time.time() - t0, len(scenes))

        job_ref.update(
            {
                "status": "done",
                "completed_at": _now_iso(),
                "scene_count": len(scenes),
                "scenes": _scenes_to_rows(scenes),
            }
        )

        # Only delete the source video from Cloudinary once the log is
        # safely persisted in Firestore.
        cloudinary_service.delete_asset(cloudinary_public_id, resource_type=resource_type)

    except Exception as e:
        log.exception("[%s] Processing failed", job_id)
        job_ref.update({"status": "failed", "completed_at": _now_iso(), "error": str(e)})
        # Deliberately NOT deleting the Cloudinary video on failure, so it can
        # be inspected/retried. The scheduled stale-video cleanup (see
        # cloudinary_service.find_stale_temp_videos) is the safety net that
        # eventually reclaims it if nobody retries the job.

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
