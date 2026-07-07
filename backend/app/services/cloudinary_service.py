"""
Cloudinary is used as:
  1. TEMPORARY storage for uploaded videos — the frontend uploads directly to
     Cloudinary using an UNSIGNED upload preset, we process the video, then we
     delete it. We never keep raw video around long-term.
  2. PERMANENT storage for small durable artifacts — trained .h5 model files
     (as `resource_type=raw`), which the Model Registry needs to keep.

The unsigned preset means the frontend never needs the API key/secret — only
`cloud_name` + `upload_preset_name` (both non-secret). The backend needs the
key/secret only for authenticated operations: deleting the temp video and
uploading model files.
"""
import logging
from typing import Optional

import cloudinary
import cloudinary.api
import cloudinary.uploader

from app.config import get_settings

log = logging.getLogger(__name__)

# Tag applied (frontend-side, via the upload preset or upload params) to every
# video uploaded for processing. Used by the stale-video cleanup safety net.
TEMP_VIDEO_TAG = "vid2log_temp"


def configure() -> None:
    settings = get_settings()
    if not settings.cloudinary_cloud_name:
        log.warning("Cloudinary is not configured (CLOUDINARY_CLOUD_NAME is empty).")
        return
    cloudinary.config(
        cloud_name=settings.cloudinary_cloud_name,
        api_key=settings.cloudinary_api_key,
        api_secret=settings.cloudinary_api_secret,
        secure=True,
    )


def get_unsigned_upload_config() -> dict:
    """Safe-to-expose config for the frontend's unsigned upload widget."""
    settings = get_settings()
    return {
        "cloud_name": settings.cloudinary_cloud_name,
        "upload_preset": settings.cloudinary_upload_preset_name,
        "tag": TEMP_VIDEO_TAG,
    }


def delete_asset(public_id: str, resource_type: str = "video") -> bool:
    """Delete a temporary video (or any asset) from Cloudinary right after
    it's no longer needed. Safe to call even if the asset is already gone."""
    try:
        result = cloudinary.uploader.destroy(
            public_id, resource_type=resource_type, invalidate=True
        )
        ok = result.get("result") in ("ok", "not found")
        if not ok:
            log.warning("Unexpected Cloudinary destroy() result for %s: %s", public_id, result)
        return ok
    except Exception:
        log.exception("Failed to delete Cloudinary asset %s (%s)", public_id, resource_type)
        return False


def upload_raw_file(local_path: str, public_id: str) -> dict:
    """Upload a durable artifact (e.g. a trained keras_model.h5) as a raw file."""
    return cloudinary.uploader.upload(
        local_path,
        public_id=public_id,
        resource_type="raw",
        overwrite=True,
    )


def find_stale_temp_videos(older_than_hours: int = 24, max_results: int = 500) -> list:
    """
    Safety-net query: list videos tagged `vid2log_temp` that are older than
    `older_than_hours`. Intended to be hit by a scheduled job (cron / Cloud
    Scheduler) in case a worker crashed mid-job and skipped its own cleanup.
    """
    import datetime

    cutoff = datetime.datetime.utcnow() - datetime.timedelta(hours=older_than_hours)
    resources = cloudinary.api.resources_by_tag(
        TEMP_VIDEO_TAG, resource_type="video", max_results=max_results
    ).get("resources", [])

    stale = []
    for r in resources:
        created_at = r.get("created_at")  # e.g. "2026-07-07T10:00:00Z"
        if not created_at:
            continue
        created_dt = datetime.datetime.strptime(created_at, "%Y-%m-%dT%H:%M:%SZ")
        if created_dt < cutoff:
            stale.append(r["public_id"])
    return stale
