import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.schemas import JobCreateRequest, JobOut, JobRenameRequest
from app.services import gcs_service
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
    Cloud Storage (via the Firebase Storage client SDK) and enqueue it for
    processing. We only ever receive the storage path here, never the video
    bytes.
    """
    db = get_db()

    if payload.model_id:
        model_doc = db.collection("models").document(payload.model_id).get()
        if not model_doc.exists:
            raise HTTPException(status_code=404, detail=f"Model '{payload.model_id}' not found in registry")

    job_id = str(uuid.uuid4())

    doc = {
        "job_id": job_id,
        "status": "queued",
        "owner_uid": user["uid"],
        "original_filename": payload.original_filename,
        "storage_path": payload.storage_path,
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
    """
    Deliberately does NOT combine `.where(owner_uid==...)` with
    `.order_by(created_at)` in the same Firestore query — Firestore requires
    a manually-created composite index for that combination, and without one
    the query raises FailedPrecondition, which (being an unhandled exception
    rather than an HTTPException) skips right past our CORS middleware and
    shows up in the browser as a confusing "blocked by CORS policy" error
    instead of a clear message. Filtering with Firestore and sorting/limiting
    in Python sidesteps the index requirement entirely — completely fine at
    one-user's-jobs scale.
    """
    db = get_db()
    docs = [d.to_dict() for d in db.collection("jobs").where("owner_uid", "==", user["uid"]).stream()]
    docs.sort(key=lambda d: d.get("created_at") or "", reverse=True)
    return [_to_job_out(d) for d in docs[:limit]]


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


@router.patch("/{job_id}", response_model=JobOut)
def rename_job(job_id: str, payload: JobRenameRequest, user: dict = Depends(get_current_user)):
    """Sets a display-only name for a job's log, shown in place of
    original_filename everywhere the frontend lists jobs. original_filename
    itself is left untouched (it's still used as the basis for the default
    CSV download filename)."""
    db = get_db()
    ref = db.collection("jobs").document(job_id)
    doc = ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Job not found")
    data = doc.to_dict()
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not your job")

    name = payload.display_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")

    ref.update({"display_name": name})
    return _to_job_out({**data, "display_name": name})


@router.delete("/{job_id}")
def cancel_or_delete_job(job_id: str, user: dict = Depends(get_current_user)):
    """
    Dual purpose, based on the job's current status:

      - `queued`: best-effort cancellation (mark intent — a worker hasn't
        picked it up yet, so nothing is actually running to interrupt).
      - `processing`: can't safely touch it — RQ doesn't give us a clean way
        to interrupt a running video-processing job, so the worker's own
        `done`/`failed` transition just wins the race.
      - `done` / `failed` / `cancelled`: genuinely removes the job/log from
        Firestore — this is what the frontend's "Delete" button (with its
        own confirmation prompt) calls for a video log the user no longer
        wants. A `done` job's source video was already deleted from Cloud
        Storage when it finished; a `failed` job's video is cleaned up here
        too (best-effort) since it otherwise only gets swept up later by the
        stale-video cleanup job.
    """
    db = get_db()
    ref = db.collection("jobs").document(job_id)
    doc = ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Job not found")
    data = doc.to_dict()
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not your job")

    status = data.get("status")
    if status == "queued":
        ref.update({"status": "cancelled"})
        return {"status": "cancelled"}
    if status == "processing":
        return {"status": status, "note": "Already picked up by a worker; cannot cancel."}

    if status == "failed" and data.get("storage_path"):
        try:
            gcs_service.delete_blob(data["storage_path"])
        except Exception:
            log.warning("Failed to delete leftover video blob for job %s", job_id, exc_info=True)

    ref.delete()
    return {"status": "deleted"}


def _to_job_out(data: dict) -> JobOut:
    return JobOut(
        job_id=data["job_id"],
        status=data["status"],
        original_filename=data["original_filename"],
        display_name=data.get("display_name"),
        model_id=data.get("model_id"),
        scene_count=data.get("scene_count"),
        error=data.get("error"),
        created_at=data.get("created_at"),
        started_at=data.get("started_at"),
        completed_at=data.get("completed_at"),
    )
