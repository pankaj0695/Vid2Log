import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.schemas import JobCreateRequest, JobOut
from app.services.firebase_service import get_current_user, get_db
from app.services.queue_service import enqueue_video_job

log = logging.getLogger(__name__)
router = APIRouter(prefix="/jobs", tags=["jobs"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("", response_model=JobOut)
def create_job(payload: JobCreateRequest, user: dict = Depends(get_current_user)):
    """
    Register a video that the frontend has ALREADY uploaded directly to
    Cloudinary (via the unsigned preset) and enqueue it for processing.
    We only ever receive the Cloudinary reference here, never the video bytes.
    """
    db = get_db()
    job_id = str(uuid.uuid4())

    doc = {
        "job_id": job_id,
        "status": "queued",
        "owner_uid": user["uid"],
        "original_filename": payload.original_filename,
        "cloudinary_public_id": payload.cloudinary_public_id,
        "cloudinary_url": payload.cloudinary_url,
        "resource_type": payload.resource_type,
        "fps": payload.fps,
        "model_id": payload.model_id,
        "created_at": _now_iso(),
    }
    db.collection("jobs").document(job_id).set(doc)
    enqueue_video_job(job_id)

    return JobOut(job_id=job_id, status="queued", original_filename=payload.original_filename, model_id=payload.model_id)


@router.get("", response_model=list[JobOut])
def list_jobs(limit: int = 50, user: dict = Depends(get_current_user)):
    db = get_db()
    query = (
        db.collection("jobs")
        .where("owner_uid", "==", user["uid"])
        .order_by("created_at", direction="DESCENDING")
        .limit(limit)
    )
    return [_to_job_out(d.to_dict()) for d in query.stream()]


@router.get("/{job_id}", response_model=JobOut)
def get_job(job_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    doc = db.collection("jobs").document(job_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Job not found")
    data = doc.to_dict()
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not your job")
    return _to_job_out(data)


@router.delete("/{job_id}")
def cancel_job(job_id: str, user: dict = Depends(get_current_user)):
    """
    Best-effort cancellation: only works while the job is still `queued`.
    Once a worker has picked it up (`processing`), RQ doesn't give us a clean
    way to interrupt a running video-processing job, so we just mark intent —
    the worker's own status transitions (`done`/`failed`) will win the race.
    """
    db = get_db()
    ref = db.collection("jobs").document(job_id)
    doc = ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Job not found")
    data = doc.to_dict()
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not your job")
    if data.get("status") == "queued":
        ref.update({"status": "cancelled"})
        return {"status": "cancelled"}
    return {"status": data.get("status"), "note": "Already picked up by a worker; cannot cancel."}


def _to_job_out(data: dict) -> JobOut:
    return JobOut(
        job_id=data["job_id"],
        status=data["status"],
        original_filename=data["original_filename"],
        model_id=data.get("model_id"),
        scene_count=data.get("scene_count"),
        error=data.get("error"),
        created_at=data.get("created_at"),
        started_at=data.get("started_at"),
        completed_at=data.get("completed_at"),
    )
