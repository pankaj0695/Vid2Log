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

import google.auth
import google.auth.transport.requests
from google.auth import impersonated_credentials
from google.cloud import storage
from google.oauth2 import service_account

from app.config import get_settings

log = logging.getLogger(__name__)

# Prefix every frontend-uploaded video lives under — the stale-cleanup
# safety net only ever looks here, mirroring Cloudinary's old
# `vid2log_temp` tag but for free, since GCS blobs already carry a creation
# timestamp with no manual tagging required.
VIDEO_UPLOAD_PREFIX = "video-uploads/"

# Where action_discovery_pipeline.py writes per-frame preview images WHILE a
# discovery job is being reviewed — TEMPORARY, same lifecycle as
# VIDEO_UPLOAD_PREFIX above. Nothing here survives past either
# POST /actions/discover/{id}/save (which copies the kept frames out to
# ACTION_DATASET_PREFIX below and then deletes the whole job's temp prefix)
# or the stale-cleanup sweep below, whichever comes first.
ACTION_DISCOVERY_TEMP_PREFIX = "action-discovery-temp/"

# Where a SAVED action dataset's images live — PERMANENT, unlike every other
# prefix in this module, until the user explicitly deletes that dataset (see
# DELETE /actions/datasets/{id}). This is deliberately a durable image store,
# not a staging area — the whole point of "Create actions" is a reusable
# labeled dataset the user can come back to and train multiple models from,
# not a one-shot temp file.
ACTION_DATASET_PREFIX = "action-datasets/"

_client: Optional[storage.Client] = None
_bucket_obj = None
# Only set when running on Application Default Credentials (no JSON key
# file) — see configure() and generate_upload_url() below.
_signing_credentials = None


def configure() -> None:
    """Sets up the GCS client + bucket handle once per process. Reuses the
    same service-account JSON as firebase_service.init_firebase() — that
    account needs the Storage Object Admin role on GCS_BUCKET_NAME granted
    via IAM (not something this code can do for you; see the README)."""
    global _client, _bucket_obj, _signing_credentials
    settings = get_settings()

    if not settings.gcs_bucket_name:
        log.warning("Cloud Storage is not configured (GCS_BUCKET_NAME is empty).")
        _client = None
        _bucket_obj = None
        _signing_credentials = None
        return

    try:
        cred_path = settings.google_application_credentials
        if cred_path and os.path.exists(cred_path):
            # A JSON key file (not just Application Default Credentials) is
            # what makes generate_upload_url() below able to sign URLs
            # locally, without an extra IAM SignBlob API round-trip.
            creds = service_account.Credentials.from_service_account_file(cred_path)
            _client = storage.Client(project=creds.project_id, credentials=creds)
            _signing_credentials = None
        else:
            # Running on GCP itself (Cloud Run/GCE/GKE) with a service
            # account ATTACHED to the instance instead of a downloaded key
            # file. google.auth.default() here returns metadata-server-backed
            # credentials with no private key material, so
            # blob.generate_signed_url() below would fail outright with
            # "you need a private key to sign credentials". The fix:
            # wrap those credentials in impersonated_credentials targeting
            # the SAME service account — this routes signing through the IAM
            # SignBlob API instead of a local RSA signature. Requires that
            # service account to hold "Service Account Token Creator"
            # (roles/iam.serviceAccountTokenCreator) ON ITSELF — see
            # DEPLOYMENT.md (repo root) → step 4, "Service account + IAM roles".
            adc_creds, project_id = google.auth.default()
            adc_creds.refresh(google.auth.transport.requests.Request())
            sa_email = getattr(adc_creds, "service_account_email", None)
            if sa_email and sa_email != "default":
                _signing_credentials = impersonated_credentials.Credentials(
                    source_credentials=adc_creds,
                    target_principal=sa_email,
                    target_scopes=["https://www.googleapis.com/auth/cloud-platform"],
                    lifetime=3600,
                )
            else:
                # Local dev without a key file and without a real GCP
                # service account attached (e.g. `gcloud auth
                # application-default login` user credentials) — signed
                # URLs will fail; everything else (direct upload/download
                # via this same client) still works fine.
                _signing_credentials = None
                log.warning(
                    "No service account email on the active credentials — "
                    "signed upload URLs will fail until either "
                    "GOOGLE_APPLICATION_CREDENTIALS points at a key file, or "
                    "this process runs under a real GCP service account."
                )
            _client = storage.Client(project=project_id, credentials=adc_creds)
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
        _signing_credentials = None


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
        # None when using a JSON key file (which already signs locally) —
        # set only under Cloud Run/GCE ADC, to route signing through the IAM
        # SignBlob API instead. See the big comment in configure() above.
        credentials=_signing_credentials,
    )


def upload_file(local_path: str, blob_path: str) -> dict:
    """Upload a durable artifact (e.g. a trained keras_model.h5) to `blob_path`
    within the bucket. Returns {"path": blob_path} — there's deliberately no
    public URL in the response; see the module docstring."""
    blob = _bucket().blob(blob_path)
    blob.upload_from_filename(local_path)
    return {"path": blob_path}


def upload_bytes(data: bytes, blob_path: str, content_type: str = "image/jpeg") -> dict:
    """Upload raw bytes (e.g. one JPEG-encoded video frame) directly, without
    a local file round-trip — used by action_discovery_pipeline.py, which
    already has each kept frame as an in-memory array/buffer, not a file on
    disk. Same "no public URL" contract as upload_file() above."""
    blob = _bucket().blob(blob_path)
    blob.upload_from_string(data, content_type=content_type)
    return {"path": blob_path}


def download_bytes(blob_path: str) -> bytes:
    """Read a blob's raw bytes straight into memory — used to stream a
    preview/dataset image back to the frontend (routers/actions.py) without
    writing it to local disk first, and without ever handing out a public
    URL for it (see the module docstring: everything is proxied through our
    own service-account-credentialed client)."""
    return _bucket().blob(blob_path).download_as_bytes()


def copy_blob(src_blob_path: str, dst_blob_path: str) -> dict:
    """Server-side copy — GCS moves the bytes between the two paths itself,
    so this never round-trips the file through our backend. Used in two
    places: (1) POST /actions/discover/{id}/save, promoting the kept preview
    frames from ACTION_DISCOVERY_TEMP_PREFIX into permanent
    ACTION_DATASET_PREFIX storage, and (2)
    POST /actions/datasets/{id}/copy-for-training, handing the training
    pipeline its own disposable copy of a permanent dataset's images so
    training_pipeline.py's post-success deletion never touches the
    original, permanent dataset."""
    src_bucket = _bucket()
    src_blob = src_bucket.blob(src_blob_path)
    src_bucket.copy_blob(src_blob, src_bucket, new_name=dst_blob_path)
    return {"path": dst_blob_path}


def list_blob_names_with_prefix(prefix: str, max_results: Optional[int] = None) -> List[str]:
    """Every blob name currently under `prefix` — used to enumerate a saved
    action dataset's images (there's no per-image Firestore doc; the image
    count alone plus this listing is enough to reconstruct what's there) and
    as the basis for delete_blobs_with_prefix() below."""
    return [b.name for b in _bucket().list_blobs(prefix=prefix, max_results=max_results)]


def delete_blobs_with_prefix(prefix: str) -> int:
    """Bulk-delete every blob under `prefix` — used to tear down a whole
    discovery job's temp preview frames (whether abandoned or just-saved)
    and to permanently delete a saved action dataset. Returns how many blobs
    were actually removed. Refuses an empty/root prefix so a coding mistake
    here can never wipe the entire bucket."""
    if not prefix or prefix == "/":
        raise ValueError("Refusing to bulk-delete with an empty/root prefix.")
    names = list_blob_names_with_prefix(prefix)
    deleted = 0
    for name in names:
        if delete_blob(name):
            deleted += 1
    return deleted


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


def find_stale_action_discovery_blobs(older_than_hours: int = 24, max_results: int = 2000) -> List[str]:
    """Same safety net as find_stale_video_blobs, for ACTION_DISCOVERY_TEMP_PREFIX.
    A discovery job's preview frames only ever leave this prefix two ways —
    promoted to ACTION_DATASET_PREFIX by a successful Save, or bulk-deleted
    when the job itself is cancelled/deleted (see routers/actions.py) — so
    anything still sitting here after `older_than_hours` means the user
    generated a preview and then just never came back to finish reviewing
    it. Safe to sweep on the same schedule as stale videos."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=older_than_hours)
    stale = []
    for blob in _bucket().list_blobs(prefix=ACTION_DISCOVERY_TEMP_PREFIX, max_results=max_results):
        if blob.time_created and blob.time_created < cutoff:
            stale.append(blob.name)
    return stale
