import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.schemas import TrainJobOut, TrainRequest
from app.services.firebase_service import get_current_user, get_db
from app.services.queue_service import enqueue_training_job

router = APIRouter(prefix="/train", tags=["train"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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
        "model_name": payload.model_name,
        "dataset": payload.dataset,
        "split": payload.split.model_dump(),
        "epochs": payload.epochs,
        "created_at": _now_iso(),
    }
    db.collection("training_jobs").document(training_job_id).set(doc)
    enqueue_training_job(training_job_id)
    return TrainJobOut(training_job_id=training_job_id, status="queued", model_name=payload.model_name)


@router.get("/{training_job_id}", response_model=TrainJobOut)
def get_training_status(training_job_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    doc = db.collection("training_jobs").document(training_job_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Training job not found")
    data = doc.to_dict()
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not your training job")
    return TrainJobOut(
        training_job_id=training_job_id,
        status=data["status"],
        model_name=data["model_name"],
        model_id=data.get("model_id"),
        metrics=data.get("metrics"),
        error=data.get("error"),
    )
