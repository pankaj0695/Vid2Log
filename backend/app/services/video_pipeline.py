"""
The core "process one video" job, run inside an RQ worker (see app/worker.py).

Lifecycle of the video itself (this is the whole point of using Cloud
Storage as TEMPORARY storage):

    Cloud Storage (uploaded by frontend via the Firebase Storage client SDK)
        --> downloaded to local /tmp on this worker
        --> classified frame-by-frame, scenes extracted
        --> scenes written to Firestore (the durable output)
        --> local /tmp file deleted (always, even on error)
        --> Cloud Storage blob deleted (once the log is safely saved)

At no point does a video get written to any permanent store.

Classification is a two-tier hybrid (see app/ml/hybrid_classifier.py): the
CNN runs on every sampled frame (cheap), and OCR + text fusion only runs when
the CNN suggests a scene change (expensive) — keeping OCR cost proportional
to the number of scenes, not the number of frames.

IMPORTANT — same hardening as training_pipeline.py (see that module's
docstring for the full story): the initial job_ref.get()/"processing" write
live INSIDE the try block, and use a short-deadline `retry=`/`timeout=`
override, so a transient Firestore/DNS error surfaces as a normal, visible,
retryable "failed" job within seconds instead of crashing the RQ job silently
for minutes with nothing ever written back.
"""
import logging
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

import cv2
from google.api_core.retry import Retry
from PIL import Image

from app.ml.classifier import get_hybrid_classifier
from app.ml.hybrid_classifier import HybridClassifier
from app.services import gcs_service
from app.services.firebase_service import get_db
from app.utils import format_timedelta

log = logging.getLogger(__name__)

# See training_pipeline.py's FIRESTORE_TIMEOUT_S/_FAST_RETRY for why both the
# per-attempt `timeout=` AND the `retry=` policy override are needed — one
# alone (just `timeout=`) does NOT bound the total retry loop.
FIRESTORE_TIMEOUT_S = 15.0
_FAST_RETRY = Retry(initial=1.0, maximum=4.0, multiplier=2.0, timeout=FIRESTORE_TIMEOUT_S)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_hybrid_classifier(db, model_id) -> HybridClassifier:
    """Looks up the Model Registry entry (if a specific model was requested)
    and assembles the CNN + OCR-text-fusion classifier for it. This is the
    fix for a gap where jobs used to reference a model_id without the
    pipeline ever actually resolving it to the registry's file/labels."""
    if not model_id:
        return get_hybrid_classifier(None)  # bundled default

    snap = db.collection("models").document(model_id).get()
    if not snap.exists:
        raise ValueError(f"Model '{model_id}' not found in the registry.")
    return get_hybrid_classifier(snap.to_dict())


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

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        frame_count += 1
        if frame_count % frame_interval != 0:
            continue

        timestamp = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000

        try:
            # NOTE: this is the ORIGINAL-resolution frame — OCR needs this,
            # not the 224x224 version the CNN resizes it down to internally.
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = Image.fromarray(frame_rgb).convert("RGB")

            cnn_label, cnn_confidence, cnn_probs = hybrid.classify_frame(image)

            if cnn_label != current_class:
                # Candidate transition — verify with OCR/text fusion before
                # committing it. This can also *reject* a one-frame CNN
                # flicker (final_label == current_class), suppressing a
                # false scene split rather than just relabeling it.
                final_label, final_confidence, meta = hybrid.verify_transition(
                    image, cnn_label, cnn_confidence, cnn_probs
                )
                ocr_calls += 1

                if final_label != current_class:
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
            else:
                last_confidence = cnn_confidence
                last_source = "cnn"

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
    log.info("OCR verification ran %d time(s) (only at candidate scene changes).", ocr_calls)
    return scenes


def _scenes_to_rows(scenes: list) -> list:
    return [
        {
            "start_time": format_timedelta(s["start"]),
            "end_time": format_timedelta(s["end"]),
            "duration": format_timedelta(s["duration"]),
            "class": s["class"],
            "confidence": s["confidence"],
            "source": s.get("source", "cnn"),
        }
        for s in scenes
    ]


def process_job(job_id: str) -> None:
    """Entry point called by the RQ worker for `video_processing` jobs."""
    db = get_db()
    job_ref = db.collection("jobs").document(job_id)
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"vid2log_{job_id}_"))

    try:
        job = job_ref.get(retry=_FAST_RETRY, timeout=FIRESTORE_TIMEOUT_S)
        if not job.exists:
            log.error("Job %s not found in Firestore.", job_id)
            return
        data = job.to_dict()

        job_ref.update(
            {"status": "processing", "started_at": _now_iso(), "completed_at": None, "error": None},
            retry=_FAST_RETRY,
            timeout=FIRESTORE_TIMEOUT_S,
        )

        storage_path = data["storage_path"]
        resource_type = data.get("resource_type", "video")

        video_path = tmp_dir / "video"
        log.info("[%s] Downloading video from Cloud Storage...", job_id)
        gcs_service.download_blob(storage_path, video_path)

        hybrid = _resolve_hybrid_classifier(db, data.get("model_id"))

        log.info("[%s] Classifying frames...", job_id)
        t0 = time.time()
        scenes = _sample_and_classify(video_path, hybrid, fps=data.get("fps", 2))
        log.info("[%s] Done in %.1fs — %d scenes.", job_id, time.time() - t0, len(scenes))

        job_ref.update(
            {
                "status": "done",
                "completed_at": _now_iso(),
                "scene_count": len(scenes),
                "scenes": _scenes_to_rows(scenes),
            },
            retry=_FAST_RETRY,
            timeout=FIRESTORE_TIMEOUT_S,
        )

        # Only delete the source video from Cloud Storage once the log is
        # safely persisted in Firestore.
        gcs_service.delete_blob(storage_path)

    except Exception as e:
        log.exception("[%s] Processing failed", job_id)
        try:
            job_ref.update(
                {"status": "failed", "completed_at": _now_iso(), "error": str(e)[:2000]},
                retry=_FAST_RETRY,
                timeout=FIRESTORE_TIMEOUT_S,
            )
        except Exception:
            log.error(
                "[%s] Also failed to write the 'failed' status to Firestore — "
                "leaving this to RQ's automatic retry (see queue_service.py).",
                job_id,
            )
            raise
        # Deliberately NOT deleting the Cloud Storage video on failure, so it
        # can be inspected/retried. The scheduled stale-video cleanup (see
        # gcs_service.find_stale_video_blobs) is the safety net that
        # eventually reclaims it if nobody retries the job.

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
