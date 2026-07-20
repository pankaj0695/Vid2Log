"""
Plain Google Cloud Storage — NOT "Firebase Storage". This is a deliberate
distinction: Firebase's Storage product requires the whole Firebase project
to be on the pay-as-you-go Blaze plan, whereas a standalone GCS bucket only
needs a GCP billing account on the project (which every GCP project needs
regardless) and stays within Cloud Storage's own free tier for light usage.
So this service talks to GCS directly via `google.cloud.storage.Client`,
authenticated with the SAME service account JSON key already used for
Firebase Admin (`GOOGLE_APPLICATION_CREDENTIALS`) — that key just also needs
the "Storage Object Admin" IAM role granted on the bucket (see
backend/README.md → "Cloud Storage setup").

Used as:
  1. TEMPORARY storage for uploaded videos and training images — the
     frontend gets a short-lived V4 **signed upload URL** from this backend
     (see routers/uploads.py) and PUTs the file bytes directly to GCS with
     it, so raw bytes never pass through our own server. We process the
     upload, then delete the blob. We never keep raw video/training-image
     bytes around long-term.
  2. PERMANENT storage for small durable artifacts — trained keras_model.h5
     / text_model.joblib files, which the Model Registry needs to keep.

This replaces Cloudinary, which had a hard 10MB cap on raw-file uploads on
the free plan — trained models routinely exceed that. There's no such cap
here (GCS objects can be many GB).

Blobs are addressed by PATH within the bucket, not by public URL — nothing
here (except the deliberately time-limited signed upload URL) is ever
publicly fetchable. The backend reads/writes/deletes everything via this
service's Admin-credentialed client; the only thing the frontend ever gets
is a one-time signed PUT URL for its own upload.
"""
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List, Optional

from google.cloud import storage
from google.oauth2 import service_account

from app.config import get_settings

log = logging.getLogger(__name__)

# Prefix every frontend-uploaded video lives under — the stale-cleanup
# safety net only ever looks here, mirroring Cloudinary's old
# `vid2log_temp` tag but for free, since GCS blobs already carry a creation
# timestamp with no manual tagging required.
VIDEO_UPLOAD_PREFIX = "video-uploads/"

_client: Optional[storage.Client] = None
_bucket_obj = None


def configure() -> None:
    """Sets up the GCS client + bucket handle once per process. Reuses the
    same service-account JSON as firebase_service.init_firebase() — that
    account needs the Storage Object Admin role on GCS_BUCKET_NAME granted
    via IAM (not something this code can do for you; see the README)."""
    global _client, _bucket_obj
    settings = get_settings()

    if not settings.gcs_bucket_name:
        log.warning("Cloud Storage is not configured (GCS_BUCKET_NAME is empty).")
        _client = None
        _bucket_obj = None
        return

    try:
        cred_path = settings.google_application_credentials
        if cred_path and os.path.exists(cred_path):
            # A JSON key file (not just Application Default Credentials) is
            # what makes generate_upload_url() below able to sign URLs
            # locally, without an extra IAM SignBlob API round-trip.
            creds = service_account.Credentials.from_service_account_file(cred_path)
            _client = storage.Client(project=creds.project_id, credentials=creds)
        else:
            _client = storage.Client()
        _bucket_obj = _client.bucket(settings.gcs_bucket_name)
        log.info("Cloud Storage configured (bucket=%s).", settings.gcs_bucket_name)
    except Exception:
        log.warning(
            "Cloud Storage could NOT be configured — uploads/downloads will fail "
            "until GCS_BUCKET_NAME + a valid service account key (with Storage "
            "Object Admin on that bucket) are set.",
            exc_info=True,
        )
        _client = None
        _bucket_obj = None


def _bucket():
    if _bucket_obj is None:
        raise RuntimeError(
            "Cloud Storage is not configured (GCS_BUCKET_NAME missing, or the "
            "service account lacks bucket access) — see backend/README.md."
        )
    return _bucket_obj


def generate_upload_url(blob_path: str, content_type: str, expires_minutes: int = 30) -> str:
    """A V4 signed URL the FRONTEND can PUT the file body to directly —
    this is what makes browser-to-GCS upload possible without either
    routing bytes through our own server or needing a Firebase-Storage-
    specific client SDK (which only works with Firebase-managed buckets).
    The `content_type` must match exactly what the frontend later sends as
    its Content-Type header, or GCS rejects the signature."""
    blob = _bucket().blob(blob_path)
    return blob.generate_signed_url(
        version="v4",
        expiration=timedelta(minutes=expires_minutes),
        method="PUT",
        content_type=content_type,
    )


def upload_file(local_path: str, blob_path: str) -> dict:
    """Upload a durable artifact (e.g. a trained keras_model.h5) to `blob_path`
    within the bucket. Returns {"path": blob_path} — there's deliberately no
    public URL in the response; see the module docstring."""
    blob = _bucket().blob(blob_path)
    blob.upload_from_filename(local_path)
    return {"path": blob_path}


def download_blob(blob_path: str, dest_path) -> Path:
    """Stream a blob down to local disk for processing (video frames, a
    training image, or a model file) — reads by blob path via our own
    service-account-credentialed client, not an HTTP GET against a public
    URL, since these blobs are never made public."""
    dest_path = Path(dest_path)
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    _bucket().blob(blob_path).download_to_filename(str(dest_path))
    return dest_path


def delete_blob(blob_path: str) -> bool:
    """Delete a blob right after it's no longer needed. Safe to call even if
    the blob is already gone (e.g. a retry racing a previous partial
    cleanup) — a 404 from GCS is treated as success, same as Cloudinary's
    `destroy()` returning "not found" was."""
    try:
        blob = _bucket().blob(blob_path)
        blob.delete()
        return True
    except Exception as e:
        # google.cloud.exceptions.NotFound also lands here — no need to
        # import it just to special-case "already gone" as fine.
        if "404" in str(e) or "No such object" in str(e) or "not found" in str(e).lower():
            return True
        log.warning("Failed to delete GCS blob %s", blob_path, exc_info=True)
        return False


def find_stale_video_blobs(older_than_hours: int = 24, max_results: int = 500) -> List[str]:
    """
    Safety-net query: list video blobs under VIDEO_UPLOAD_PREFIX older than
    `older_than_hours`. Intended to be hit by a scheduled job (cron / Cloud
    Scheduler) in case a worker crashed mid-job and skipped its own cleanup —
    identical purpose to the old `cloudinary_service.find_stale_temp_videos`,
    just against `blob.time_created` (free, built into every GCS object)
    instead of a hand-applied Cloudinary tag.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=older_than_hours)
    stale = []
    for blob in _bucket().list_blobs(prefix=VIDEO_UPLOAD_PREFIX, max_results=max_results):
        if blob.time_created and blob.time_created < cutoff:
            stale.append(blob.name)
    return stale
