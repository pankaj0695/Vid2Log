"""
Admin-only surface: system-wide visibility (stats, user list) plus the
operational safety net that reclaims any Cloud Storage video blob that
somehow survived past the normal "delete right after processing" flow (e.g.
a worker crashed mid-job). Every endpoint here requires role="admin" in
Firestore's `users` collection (see require_admin in firebase_service.py) —
a plain "user" gets a 403, same as an unauthenticated caller gets a 401.
"""
from fastapi import APIRouter, Depends, HTTPException

from app.schemas import AdminStats, UserProfile, UserRoleUpdateRequest
from app.services import gcs_service
from app.services.firebase_service import get_db, require_admin

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/cleanup-stale-videos")
def cleanup_stale_videos(older_than_hours: int = 24, user: dict = Depends(require_admin)):
    """Meant to be hit periodically by a scheduler (Cloud Scheduler / cron)
    using an admin account's token, not by end users during normal use."""
    stale_paths = gcs_service.find_stale_video_blobs(older_than_hours=older_than_hours)
    deleted = [path for path in stale_paths if gcs_service.delete_blob(path)]
    return {"found": len(stale_paths), "deleted": len(deleted), "blob_paths": deleted}


@router.get("/users", response_model=list[UserProfile])
def list_users(limit: int = 200, user: dict = Depends(require_admin)):
    db = get_db()
    docs = db.collection("users").order_by("created_at", direction="DESCENDING").limit(limit).stream()
    return [
        UserProfile(
            uid=d.id,
            email=data.get("email"),
            display_name=data.get("display_name"),
            role=data.get("role", "user"),
            created_at=data.get("created_at"),
        )
        for d in docs
        for data in [d.to_dict()]
    ]


@router.patch("/users/{uid}/role", response_model=UserProfile)
def update_user_role(uid: str, payload: UserRoleUpdateRequest, user: dict = Depends(require_admin)):
    """Convenience alternative to editing Firestore by hand — still gated
    behind an existing admin, so the very first admin always has to be set
    manually in the Firestore console."""
    db = get_db()
    ref = db.collection("users").document(uid)
    doc = ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="User not found")
    ref.update({"role": payload.role})
    data = doc.to_dict()
    data["role"] = payload.role
    return UserProfile(
        uid=uid,
        email=data.get("email"),
        display_name=data.get("display_name"),
        role=payload.role,
        created_at=data.get("created_at"),
    )


@router.get("/stats", response_model=AdminStats)
def get_stats(user: dict = Depends(require_admin)):
    db = get_db()

    users = [d.to_dict() for d in db.collection("users").stream()]
    total_admins = sum(1 for u in users if u.get("role") == "admin")

    jobs = [d.to_dict() for d in db.collection("jobs").stream()]
    jobs_by_status: dict = {}
    for j in jobs:
        jobs_by_status[j.get("status", "unknown")] = jobs_by_status.get(j.get("status", "unknown"), 0) + 1

    models = [d.to_dict() for d in db.collection("models").stream()]
    active_model = next((m for m in models if m.get("is_active")), None)

    training_jobs_count = len(list(db.collection("training_jobs").stream()))

    return AdminStats(
        total_users=len(users),
        total_admins=total_admins,
        total_jobs=len(jobs),
        jobs_by_status=jobs_by_status,
        total_models=len(models),
        active_model_id=active_model["model_id"] if active_model else None,
        total_training_jobs=training_jobs_count,
    )
