import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.schemas import TrainJobOut, TrainRequest
from app.services.firebase_service import get_current_user, get_db
from app.services.queue_service import enqueue_training_job
from app.utils import metrics_from_firestore

router = APIRouter(prefix="/train", tags=["train"])

# A "processing" job is only retryable once it's been running long enough
# that it's almost certainly dead (worker crashed/lost its Firestore
# connection) rather than genuinely still working — see run_training_job()'s
# docstring for the kind of transient failure this is meant to catch. Keep
# this generous: real training runs (esp. with OCR + fusion tuning) can
# legitimately take a while.
STUCK_PROCESSING_AFTER_SECONDS = 30 * 60


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_retryable(data: dict) -> bool:
    status = data.get("status")
    if status == "failed":
        return True
    if status == "queued":
        # Trusted as-is — the frontend only surfaces the Retry button once a
        # queued job has been sitting for a couple of minutes, but the
        # backend doesn't need its own opinion on "how long is too long"
        # here; queued (unlike processing) can never be a job actively doing
        # expensive work, so there's no risk in allowing it any time.
        return True
    if status == "processing":
        started_at = data.get("started_at")
        if not started_at:
            return False
        try:
            started = datetime.fromisoformat(started_at)
        except ValueError:
            return False
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - started).total_seconds() > STUCK_PROCESSING_AFTER_SECONDS
    return False


def _to_train_job_out(data: dict) -> TrainJobOut:
    return TrainJobOut(
        training_job_id=data["training_job_id"],
        status=data["status"],
        model_name=data["model_name"],
        model_id=data.get("model_id"),
        # See training_pipeline.py's metrics_to_firestore() docstring —
        # confusion_matrix is stored reshaped for Firestore and converted
        # back to plain number[][] here before it reaches the frontend.
        metrics=metrics_from_firestore(data.get("metrics")),
        error=data.get("error"),
        created_at=data.get("created_at"),
        started_at=data.get("started_at"),
        class_names=sorted((data.get("dataset") or {}).keys()) or None,
        progress=data.get("progress"),
        retry_count=data.get("retry_count", 0),
        epochs=data.get("epochs"),
        batch_size=data.get("batch_size"),
        learning_rate=data.get("learning_rate"),
        split=data.get("split"),
    )


@router.post("", response_model=TrainJobOut)
def start_training(payload: TrainRequest, user: dict = Depends(get_current_user)):
    """
    Kicks off the in-app training module: stratified train/val/test split,
    MobileNetV2 transfer learning, and a full test-set metrics report — the
    thing Teachable Machine doesn't give you. Runs asynchronously on the
    `training` queue; poll GET /train/{training_job_id} for status + metrics.
    """
    db = get_db()
    training_job_id = str(uuid.uuid4())
    doc = {
        "training_job_id": training_job_id,
        "status": "queued",
        "owner_uid": user["uid"],
        "created_at": _now_iso(),
        "model_name": payload.model_name,
        # Firestore needs plain dicts/lists, not Pydantic model instances.
        "dataset": {
            class_name: [image.model_dump() for image in images]
            for class_name, images in payload.dataset.items()
        },
        "split": payload.split.model_dump(),
        "epochs": payload.epochs,
        "batch_size": payload.batch_size,
        "learning_rate": payload.learning_rate,
        "keyword_rules": payload.keyword_rules,
        "retry_count": 0,
    }
    db.collection("training_jobs").document(training_job_id).set(doc)
    enqueue_training_job(training_job_id)
    return _to_train_job_out(doc)


@router.get("", response_model=list[TrainJobOut])
def list_training_jobs(limit: int = 50, user: dict = Depends(get_current_user)):
    """
    Lists your training jobs, most recent first — including failed ones, so
    a failed run (e.g. a local TensorFlow/environment hiccup) is visible and
    retryable from the UI instead of just vanishing. Filters in Firestore and
    sorts in Python rather than combining `.where()` with `.order_by()` on a
    different field — that combination needs a manually-created Firestore
    composite index, and without one raises FailedPrecondition, which (being
    an unhandled exception) skips past our CORS middleware and shows up in
    the browser as a confusing "blocked by CORS policy" error instead of a
    clear one. See the identical fix in routers/jobs.py::list_jobs.
    """
    db = get_db()
    docs = [d.to_dict() for d in db.collection("training_jobs").where("owner_uid", "==", user["uid"]).stream()]
    docs.sort(key=lambda d: d.get("created_at") or "", reverse=True)
    return [_to_train_job_out(d) for d in docs[:limit]]


@router.get("/{training_job_id}", response_model=TrainJobOut)
def get_training_status(training_job_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    doc = db.collection("training_jobs").document(training_job_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Training job not found")
    data = doc.to_dict()
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not your training job")
    return _to_train_job_out(data)


@router.post("/{training_job_id}/retry", response_model=TrainJobOut)
def retry_training(training_job_id: str, user: dict = Depends(get_current_user)):
    """
    Re-runs a failed / stuck-queued / stuck-processing training job with the
    EXACT SAME dataset, split, epochs, and keyword rules — no re-upload
    needed. Only works because a non-"done" run keeps its training images in
    Cloud Storage instead of deleting them (see training_pipeline.py's
    cleanup policy).

    Re-queues this SAME Firestore document (same training_job_id) rather
    than creating a new one — earlier this created a fresh doc/id per retry,
    which meant every retry of a stuck job left the old stuck copy behind
    forever and cluttered the job history with duplicates of the same
    underlying attempt. `retry_count` tracks how many times this has
    happened instead.
    """
    db = get_db()
    doc_ref = db.collection("training_jobs").document(training_job_id)
    doc = doc_ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Training job not found")
    data = doc.to_dict()
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not your training job")
    if not _is_retryable(data):
        status = data.get("status")
        detail = (
            f"This job is currently '{status}' — wait for it to finish (or for it to look stuck for a while) "
            "before retrying."
            if status == "processing"
            else f"Only failed or stuck jobs can be retried (this job is '{status}')."
        )
        raise HTTPException(status_code=409, detail=detail)

    updates = {
        "status": "queued",
        "error": None,
        "progress": None,
        "started_at": None,
        "completed_at": None,
        "retry_count": data.get("retry_count", 0) + 1,
    }
    doc_ref.update(updates)
    enqueue_training_job(training_job_id)
    return _to_train_job_out({**data, **updates})
