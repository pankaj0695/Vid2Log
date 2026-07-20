import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.schemas import KeywordRulesUpdateRequest, ModelOut, ModelRegisterRequest
from app.services.firebase_service import get_current_user, get_db
from app.utils import metrics_from_firestore, metrics_to_firestore

router = APIRouter(prefix="/models", tags=["models"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_model_out(data: dict) -> ModelOut:
    # See training_pipeline.py's metrics_to_firestore() docstring — Firestore
    # can't store a confusion_matrix's List[List[int]] as-is, so it's stored
    # reshaped and converted back to plain number[][] here, right before it
    # reaches the frontend.
    return ModelOut(**{**data, "metrics": metrics_from_firestore(data.get("metrics"))})


@router.get("", response_model=list[ModelOut])
def list_models(user: dict = Depends(get_current_user)):
    db = get_db()
    docs = db.collection("models").order_by("created_at", direction="DESCENDING").stream()
    return [_to_model_out(d.to_dict()) for d in docs]


@router.get("/{model_id}", response_model=ModelOut)
def get_model(model_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    doc = db.collection("models").document(model_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Model not found")
    return _to_model_out(doc.to_dict())


@router.post("", response_model=ModelOut)
def register_model(payload: ModelRegisterRequest, user: dict = Depends(get_current_user)):
    """
    Manually register a model that was trained OUTSIDE this API — e.g. still
    via Teachable Machine — and already uploaded to Cloud Storage as a raw
    .h5 file. Keeps the door open for the point-and-click workflow alongside
    the in-app training module.
    """
    db = get_db()
    model_id = str(uuid.uuid4())
    doc = {
        "model_id": model_id,
        "name": payload.name,
        "labels": payload.labels,
        "model_storage_path": payload.model_storage_path,
        # Same Firestore array-of-arrays restriction as the in-app training
        # pipeline hits — see training_pipeline.py's metrics_to_firestore().
        "metrics": metrics_to_firestore(payload.metrics),
        "dataset_version": payload.dataset_version,
        "is_active": False,
        "created_at": _now_iso(),
        "text_model_storage_path": payload.text_model_storage_path,
        "fusion_alpha": payload.fusion_alpha,
        "fusion_alpha_per_class": payload.fusion_alpha_per_class,
        "keyword_rules": payload.keyword_rules,
    }
    db.collection("models").document(model_id).set(doc)
    return _to_model_out(doc)


@router.patch("/{model_id}/keyword-rules", response_model=ModelOut)
def update_keyword_rules(model_id: str, payload: KeywordRulesUpdateRequest, user: dict = Depends(get_current_user)):
    """
    Update the fuzzy-keyword override used by the OCR fusion tier (see
    app/ml/text_rules.py) WITHOUT retraining anything — useful for quickly
    tightening/adding rules once you see how OCR text actually looks for
    your screens, or for covering a brand-new class that has no training
    data yet but a known, fixed on-screen header.
    """
    db = get_db()
    ref = db.collection("models").document(model_id)
    doc = ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Model not found")
    ref.update({"keyword_rules": payload.keyword_rules})
    return _to_model_out(ref.get().to_dict())


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
    return _to_model_out(ref.get().to_dict())
