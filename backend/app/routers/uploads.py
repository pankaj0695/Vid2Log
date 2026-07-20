import logging
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.schemas import SignedUploadRequest, SignedUploadResponse
from app.services import gcs_service
from app.services.firebase_service import get_current_user

log = logging.getLogger(__name__)
router = APIRouter(prefix="/uploads", tags=["uploads"])

# kind -> blob-path prefix. Deliberately a closed allow-list (not a raw path
# the client can pick) so a signed-URL request can never write outside its
# own uid-scoped area of the bucket.
_KIND_PREFIXES = {
    "video": "video-uploads",
    "training-image": "training-uploads",
    "model-file": "model-uploads",
}

# Keep the original filename's extension (helps eyeballing the bucket in the
# GCS console) but strip everything else, so path-traversal / weird
# characters in a user-supplied filename can't do anything odd to the blob
# path.
_SAFE_EXT = re.compile(r"^[A-Za-z0-9]{1,10}$")


def _extension_of(filename: str) -> str:
    if "." in filename:
        ext = filename.rsplit(".", 1)[-1]
        if _SAFE_EXT.match(ext):
            return f".{ext.lower()}"
    return ""


@router.post("/signed-url", response_model=SignedUploadResponse)
def create_signed_upload_url(payload: SignedUploadRequest, user: dict = Depends(get_current_user)):
    """
    Issues a short-lived V4 signed PUT URL for a single file, scoped under
    the caller's own uid so one user can never overwrite another's blobs.
    The frontend PUTs the raw file bytes straight to Google Cloud Storage
    with this URL (Content-Type header must match `content_type` exactly —
    GCS rejects the request otherwise), then calls /jobs or /train with the
    returned `storage_path`. The backend's own service-account credentials
    never touch the file bytes either; the whole point is to keep large
    uploads off our own server entirely.
    """
    prefix = _KIND_PREFIXES.get(payload.kind)
    if prefix is None:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid kind '{payload.kind}' — must be one of {sorted(_KIND_PREFIXES)}.",
        )

    blob_path = f"{prefix}/{user['uid']}/{uuid.uuid4().hex}{_extension_of(payload.filename)}"

    try:
        upload_url = gcs_service.generate_upload_url(blob_path, payload.content_type)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))

    return SignedUploadResponse(upload_url=upload_url, storage_path=blob_path)
