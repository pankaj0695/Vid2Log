import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.schemas import ModelOut, ModelRegisterRequest
from app.services.firebase_service import get_current_user, get_db

router = APIRouter(prefix="/models", tags=["models"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.get("", response_model=list[ModelOut])
def list_models(user: dict = Depends(get_current_user)):
    db = get_db()
    docs = db.collection("models").order_by("created_at", direction="DESCENDING").stream()
    return [ModelOut(**d.to_dict()) for d in docs]


@router.get("/{model_id}", response_model=ModelOut)
def get_model(model_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    doc = db.collection("models").document(model_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Model not found")
    return ModelOut(**doc.to_dict())


@router.post("", response_model=ModelOut)
def register_model(payload: ModelRegisterRequest, user: dict = Depends(get_current_user)):
    """
    Manually register a model that was trained OUTSIDE this API — e.g. still
    via Teachable Machine — and already uploaded to Cloudinary as a raw .h5
    file. Keeps the door open for the point-and-click workflow alongside the
    in-app training module.
    """
    db = get_db()
    model_id = str(uuid.uuid4())
    doc = {
        "model_id": model_id,
        "name": payload.name,
        "labels": payload.labels,
        "cloudinary_url": payload.cloudinary_url,
        "cloudinary_public_id": payload.cloudinary_public_id,
        "metrics": payload.metrics,
        "dataset_version": payload.dataset_version,
        "is_active": False,
        "created_at": _now_iso(),
    }
    db.collection("models").document(model_id).set(doc)
    return ModelOut(**doc)


@router.patch("/{model_id}/activate", response_model=ModelOut)
def activate_model(model_id: str, user: dict = Depends(get_current_user)):
    """Marks this model as the default used for new jobs that don't specify
    a model_id explicitly. Unsets any previously-active model."""
    db = get_db()
    ref = db.collection("models").document(model_id)
    doc = ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Model not found")

    for other in db.collection("models").where("is_active", "==", True).stream():
        other.reference.update({"is_active": False})

    ref.update({"is_active": True})
    return ModelOut(**ref.get().to_dict())
