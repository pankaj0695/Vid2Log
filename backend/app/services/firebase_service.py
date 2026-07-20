"""
Firebase Admin — used for three things:
  1. Verifying the Firebase Auth ID token the frontend sends on every request
     (Authorization: Bearer <token>).
  2. Firestore as the metadata store: jobs, logs (scenes), the model registry,
     and training jobs. (Videos/training images/model files themselves live
     in a STANDALONE Google Cloud Storage bucket — not Firebase Storage —
     temporarily or permanently depending on the asset; see
     app/services/gcs_service.py, which uses its own `google.cloud.storage.Client`
     rather than anything initialized here.)

The app is designed to boot even if Firebase isn't configured yet (e.g. first
`docker compose up` before secrets are filled in) — auth/Firestore-backed
endpoints will return a clear 503 instead of crashing the whole process.
"""
import logging
import os
from typing import Optional

import firebase_admin
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials, firestore

from app.config import get_settings

log = logging.getLogger(__name__)

_app: Optional[firebase_admin.App] = None
_db = None

bearer_scheme = HTTPBearer(auto_error=False)


def init_firebase() -> None:
    global _app, _db
    settings = get_settings()

    if firebase_admin._apps:
        _app = firebase_admin.get_app()
        _db = firestore.client()
        return

    try:
        cred_path = settings.google_application_credentials
        if cred_path and os.path.exists(cred_path):
            cred = credentials.Certificate(cred_path)
        else:
            # Falls back to GOOGLE_APPLICATION_CREDENTIALS env var or the
            # metadata server (e.g. when running on Cloud Run with a
            # service account attached) if no explicit path is set.
            cred = credentials.ApplicationDefault()

        options = {}
        if settings.firebase_project_id:
            options["projectId"] = settings.firebase_project_id
        _app = firebase_admin.initialize_app(cred, options or None)
        _db = firestore.client()
        log.info("Firebase Admin initialized (project=%s).", settings.firebase_project_id)
    except Exception:
        log.warning(
            "Firebase Admin could NOT be initialized — auth and Firestore "
            "endpoints will return 503 until GOOGLE_APPLICATION_CREDENTIALS "
            "points at a valid service account key.",
            exc_info=True,
        )
        _app = None
        _db = None


def is_configured() -> bool:
    return _db is not None


def get_db():
    if _db is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Firebase is not configured on the server (missing service account).",
        )
    return _db


async def get_current_user(
    credentials_: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> dict:
    """FastAPI dependency — verifies the Firebase ID token and returns the
    decoded claims (uid, email, etc.). Use via `Depends(get_current_user)`."""
    if _app is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Firebase is not configured on the server (missing service account).",
        )
    if credentials_ is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization: Bearer <Firebase ID token> header.",
        )
    try:
        decoded = firebase_auth.verify_id_token(credentials_.credentials)
        return decoded
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid or expired Firebase ID token: {e}",
        )


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """FastAPI dependency for admin-only endpoints. Looks the caller's role
    up fresh from Firestore's `users` collection on every request — role is
    only ever promoted by hand there, never through the API, so this is the
    single source of truth (never trust a role claimed by the client)."""
    db = get_db()
    doc = db.collection("users").document(user["uid"]).get()
    if not doc.exists or doc.to_dict().get("role") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required.")
    return user
