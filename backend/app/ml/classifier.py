"""
Loads models for the vid2log classification pipeline and assembles a
HybridClassifier (CNN + optional OCR text classifier + keyword rules) for a
given model — either the bundled default (mirrors the original Streamlit
app exactly) or one pulled from the Model Registry / Cloud Storage.

get_hybrid_classifier() is the entry point used by the video pipeline.
"""
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image
from tf_keras.layers import DepthwiseConv2D
from tf_keras.models import load_model

from app.ml.hybrid_classifier import ClassifyFn, HybridClassifier
from app.ml.preprocessing import resize_with_padding
from app.ml.text_classifier import load_text_classifier
from app.services import gcs_service

log = logging.getLogger(__name__)

_DEFAULT_MODEL_DIR = Path(__file__).parent / "default_model"
_CACHE_DIR = Path("/tmp/vid2log_models")

# In-process caches, keyed by model_id ("__default__" for the bundled model).
_cnn_cache: Dict[str, Tuple[object, List[str]]] = {}
_text_model_cache: Dict[str, object] = {}


class _DepthwiseConv2DCompat(DepthwiseConv2D):
    """Some older Teachable Machine exports include a `groups` kwarg that
    newer Keras versions reject — strip it, same fix as the Streamlit app."""

    def __init__(self, *args, **kwargs):
        kwargs.pop("groups", None)
        super().__init__(*args, **kwargs)


def _load_cnn_from_disk(h5_path: Path, labels_path: Path):
    model = load_model(
        str(h5_path), compile=False, custom_objects={"DepthwiseConv2D": _DepthwiseConv2DCompat}
    )
    class_names = [line.strip() for line in open(labels_path, "r").readlines()]
    return model, class_names


def _get_default_cnn() -> Tuple[object, List[str]]:
    if "__default__" not in _cnn_cache:
        log.info("Loading default bundled model from %s", _DEFAULT_MODEL_DIR)
        _cnn_cache["__default__"] = _load_cnn_from_disk(
            _DEFAULT_MODEL_DIR / "keras_model.h5", _DEFAULT_MODEL_DIR / "labels.txt"
        )
    return _cnn_cache["__default__"]


def _make_cnn_classify_fn(model, class_names: List[str]) -> ClassifyFn:
    def classify_image(image: Image.Image) -> Tuple[str, float, np.ndarray]:
        resized = resize_with_padding(image)
        arr = np.asarray(resized).astype(np.float32)
        normalized = (arr / 127.5) - 1
        data = np.expand_dims(normalized, axis=0)
        probs = model(data, training=False).numpy()[0]
        idx = int(np.argmax(probs))
        return class_names[idx], float(probs[idx]), probs

    return classify_image


def get_hybrid_classifier(model_doc: Optional[dict] = None) -> HybridClassifier:
    """
    model_doc: the Firestore `models/{id}` document dict for the requested
    model, or None to use the bundled default (CNN only, no text fusion —
    identical behavior to the original Streamlit app).
    """
    if model_doc is None:
        model, class_names = _get_default_cnn()
        return HybridClassifier(cnn_classify_fn=_make_cnn_classify_fn(model, class_names), class_names=class_names)

    model_id = model_doc["model_id"]
    class_names = model_doc["labels"]

    if model_id not in _cnn_cache:
        local_dir = _CACHE_DIR / model_id
        h5_path = local_dir / "keras_model.h5"
        if not h5_path.exists():
            log.info("Downloading CNN for model %s from Cloud Storage...", model_id)
            gcs_service.download_blob(model_doc["model_storage_path"], h5_path)
        labels_path = local_dir / "labels.txt"
        labels_path.write_text("\n".join(class_names))
        _cnn_cache[model_id] = _load_cnn_from_disk(h5_path, labels_path)
    model, cached_class_names = _cnn_cache[model_id]

    text_model = None
    text_storage_path = model_doc.get("text_model_storage_path")
    if text_storage_path:
        if model_id not in _text_model_cache:
            local_path = _CACHE_DIR / model_id / "text_model.joblib"
            if not local_path.exists():
                log.info("Downloading text classifier for model %s from Cloud Storage...", model_id)
                gcs_service.download_blob(text_storage_path, local_path)
            _text_model_cache[model_id] = load_text_classifier(local_path)
        text_model = _text_model_cache[model_id]

    return HybridClassifier(
        cnn_classify_fn=_make_cnn_classify_fn(model, cached_class_names),
        class_names=cached_class_names,
        text_model=text_model,
        keyword_rules=model_doc.get("keyword_rules"),
        fusion_alpha=model_doc.get("fusion_alpha", 0.6),
        fusion_alpha_per_class=model_doc.get("fusion_alpha_per_class"),
        ocr_roi=model_doc.get("ocr_roi"),
    )
