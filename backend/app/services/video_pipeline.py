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

FLICKER REDUCTION (Phase 1 — see Fixing_Log_Flicker_Plan.md at the repo root
for the full writeup): a raw per-frame classifier will always have some
frames near a class boundary where confidence is a near-tie, and without any
temporal smoothing that shows up as the scene log flipping back and forth
every sample instead of holding one class for a real, meaningful duration —
this was measured directly against a manually-corrected log (76% of a real
video's transitions were spurious `GameWorkspace <-> ProductPlacement`
flips). Three independent, composable fixes for that, all pure pipeline
logic — no retraining involved:

  1. Hysteresis (HYSTERESIS_FRAMES, in _sample_and_classify): a candidate
     class must be the CNN's own top pick for several CONSECUTIVE sampled
     frames before OCR verification is even attempted, so a single
     flickering frame never reaches the "should we switch" decision at all.
  2. Confidence floor (MIN_SWITCH_CONFIDENCE): even once a candidate clears
     hysteresis and gets OCR-verified, only actually commit the switch if
     the verified confidence clears this bar — a near-tie stays in the
     current class instead of switching on noise.
  3. Post-hoc despike (MIN_SCENE_DURATION_S, _merge_short_scenes): after
     scenes are built, any leftover scene that's still suspiciously short
     AND sandwiched between two scenes of the SAME class gets folded back
     into that class, on the theory that a single-frame-scale blip inside an
     otherwise-long scene of one class is noise, not a real second class.
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

# Flicker-reduction constants (Phase 1 — see the module docstring above and
# Fixing_Log_Flicker_Plan.md). Units are SAMPLED frames, not raw video
# frames or seconds — e.g. at the default fps=2, HYSTERESIS_FRAMES=2 means
# "the same candidate class for 2 consecutive samples", i.e. ~1s of
# agreement, before it's even worth an OCR call.
#
# Tuned down from (3, 0.6) after comparing a real processed video against
# its manually-corrected log: the flicker was gone, but real BRIEF events
# (ProductPlacement scenes averaging ~9s in the correction) were being
# under-detected — dropping to ~5% of their true share of the video, with
# GameWorkspace absorbing the difference, because requiring 3 confirmed
# frames AND >=0.6 confidence was too strict for genuinely short real
# events, not just noise. (Separately, that same comparison found the CNN
# itself has a real, systematic GameWorkspace<->Bulldozing confusion in
# part of that video — hysteresis made that MORE visible, since it lets a
# real class change persist. No amount of tuning these two constants fixes
# that; it needs better training data for those two classes. See
# Fixing_Log_Flicker_Plan.md Phase 3.)
HYSTERESIS_FRAMES = 2
MIN_SWITCH_CONFIDENCE = 0.5
MIN_SCENE_DURATION_S = 2.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _resolve_hybrid_classifier(db, model_id) -> HybridClassifier:
    """Looks up the Model Registry entry (if a specific model was requested)
    and assembles the CNN + OCR-text-fusion classifier for it. This is the
    fix for a gap where jobs used to reference a model_id without the
    pipeline ever actually resolving it to the registry's file/labels.

    No model_id means "use whatever's active" (see JobCreateRequest.model_id
    in schemas.py) — NOT "use the bundled default". Previously this fell
    straight through to the bundled Teachable-Machine-style model shipped in
    app/ml/default_model/ instead of actually looking up the registry's
    is_active model, silently ignoring the active model the "Use active
    model" option in the frontend implies. The bundled default is now only
    a last resort for a brand-new registry that has no active model yet
    (e.g. nothing trained/activated) — same as `is_active` starting False on
    every newly-created model and there being no admin action that sets one
    active by default."""
    if not model_id:
        active_docs = list(db.collection("models").where("is_active", "==", True).limit(1).stream())
        if active_docs:
            return get_hybrid_classifier(active_docs[0].to_dict())
        log.warning("No active model in the registry and no model_id given — falling back to the bundled default.")
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

    # Hysteresis state — see HYSTERESIS_FRAMES. Tracks a candidate class that
    # differs from current_class and how many CONSECUTIVE sampled frames the
    # CNN has now agreed on it. Only once that streak clears the threshold do
    # we spend an OCR call finding out whether it's real.
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
            # NOTE: this is the ORIGINAL-resolution frame — OCR needs this,
            # not the 224x224 version the CNN resizes it down to internally.
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = Image.fromarray(frame_rgb).convert("RGB")

            cnn_label, cnn_confidence, cnn_probs = hybrid.classify_frame(image)

            if cnn_label == current_class:
                # Stable — no candidate transition in flight, nothing to
                # debounce. This is also what resets the streak after a
                # rejected/aborted candidate.
                candidate_class = None
                candidate_streak = 0
                last_confidence = cnn_confidence
                last_source = "cnn"
                continue

            # cnn_label differs from current_class. Build (or continue) a
            # streak on this specific candidate — a DIFFERENT differing
            # label restarts the streak rather than accumulating across
            # unrelated candidates.
            if cnn_label == candidate_class:
                candidate_streak += 1
            else:
                candidate_class = cnn_label
                candidate_streak = 1

            if candidate_streak < HYSTERESIS_FRAMES:
                # Not yet confirmed by enough consecutive frames — too cheap
                # a signal to spend an OCR call on. Current class's own last
                # reading stands untouched.
                continue

            # Candidate has now been the CNN's top pick for HYSTERESIS_FRAMES
            # samples in a row — worth the expensive OCR verification. This
            # can also *reject* the candidate (final_label == current_class),
            # suppressing a false scene split rather than just relabeling it.
            final_label, final_confidence, meta = hybrid.verify_transition(
                image, cnn_label, cnn_confidence, cnn_probs
            )
            ocr_calls += 1

            if final_label == current_class:
                # OCR verification rejected the candidate — current_class
                # continues, and this confidence describes it.
                last_confidence = final_confidence
                last_source = meta.get("source", "cnn")
            elif final_confidence >= MIN_SWITCH_CONFIDENCE:
                # Confirmed AND confident enough — actually switch.
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
            # else: differs from current_class but below MIN_SWITCH_CONFIDENCE
            # — a near-tie. Stay in current_class rather than switch on
            # noise; deliberately leave last_confidence/last_source alone so
            # this weak, off-class reading doesn't overwrite the current
            # class's own last known confidence.

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
    """Post-hoc despike pass (see MIN_SCENE_DURATION_S / module docstring).

    Deliberately conservative: only collapses a short scene when it's a pure
    A -> B -> A spike (both neighbors share the SAME class), folding B back
    into that shared class. A short scene between two DIFFERENT classes is
    left alone — that's a real boundary (or something hysteresis should
    already have filtered), not a blip to erase, and could itself be a real
    brief event (e.g. a quick ProductSelection).

    Repeats until no more A-B-A spikes are found — this also cleans up
    chains like A-B-A-B-A that hysteresis alone didn't fully collapse,
    since each pass removes one spike and can expose another.
    """
    if len(scenes) < 3:
        return scenes

    merged = [dict(s) for s in scenes]
    changed = True
    while changed and len(merged) >= 3:
        changed = False
        for i in range(1, len(merged) - 1):
            spike, prev_s, next_s = merged[i], merged[i - 1], merged[i + 1]
            if spike["duration"] < min_duration_s and prev_s["class"] == next_s["class"]:
                # Collapse prev + spike + next into one scene spanning all
                # three — contiguity holds automatically since prev.end ==
                # spike.start and spike.end == next.start already.
                prev_s["end"] = next_s["end"]
                prev_s["duration"] = prev_s["end"] - prev_s["start"]
                prev_s["confidence"] = next_s["confidence"]
                prev_s["source"] = next_s["source"]
                del merged[i : i + 2]  # remove spike and next; prev now covers both
                changed = True
                break  # indices shifted — restart the scan
    return merged


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
