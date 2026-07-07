"""
Operational safety net: reclaims any Cloudinary video that somehow survived
past the normal "delete right after processing" flow (e.g. a worker crashed
mid-job). This endpoint is meant to be hit periodically by a scheduler
(Cloud Scheduler / cron), not by end users — wire it up once deployed.
"""
from fastapi import APIRouter, Depends

from app.services import cloudinary_service
from app.services.firebase_service import get_current_user

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/cleanup-stale-videos")
def cleanup_stale_videos(older_than_hours: int = 24, user: dict = Depends(get_current_user)):
    stale_ids = cloudinary_service.find_stale_temp_videos(older_than_hours=older_than_hours)
    deleted = [pid for pid in stale_ids if cloudinary_service.delete_asset(pid, resource_type="video")]
    return {"found": len(stale_ids), "deleted": len(deleted), "public_ids": deleted}
