"""
Loads models for the vid2log classification pipeline and assembles a
HybridClassifier (CNN + optional OCR text classifier + keyword rules) for a
given model — either the bundled default (mirrors the original Streamlit
app / cloud backend exactly) or a locally-trained model.

This is the offline-desktop counterpart of backend/app/ml/classifier.py.
The only real difference from the cloud version: "custom" models are read
straight off local disk (app/config.MODELS_DIR / {model_id}/) instead of
being downloaded from Cloud Storage on first use — there's no network layer
here at all, offline by construction, not by configuration. Those model
directories are written by app/training_pipeline.py.

get_hybrid_classifier() is the entry point used by video_pipeline.py.
"""
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image
from tf_keras.layers import DepthwiseConv2D
from tf_keras.models import load_model

from app.bundle import resource_dir
from app.config import MODELS_DIR
from app.ml.hybrid_classifier import ClassifyFn, HybridClassifier
from app.ml.preprocessing import resize_with_padding
from app.ml.text_classifier import load_text_classifier

log = logging.getLogger(__name__)

# Resolved through app/bundle.py rather than `Path(__file__).parent` so it
# also works once frozen — PyInstaller unpacks bundled data to a temp dir
# (or beside the executable), where this module's `__file__` no longer
# points anywhere useful. See the PyInstaller spec's `datas` entry, which is
# what puts default_model at this path inside the bundle.
_DEFAULT_MODEL_DIR = resource_dir() / "app" / "ml" / "default_model"

# In-process caches, keyed by model_id ("__default__" for the bundled model).
_cnn_cache: Dict[str, Tuple[object, List[str]]] = {}
_text_model_cache: Dict[str, object] = {}


class _DepthwiseConv2DCompat(DepthwiseConv2D):
    """Some older Teachable Machine exports include a `groups` kwarg that
    newer Keras versions reject — strip it, same fix as the Streamlit app
    and the cloud backend."""

    def __init__(self, *args, **kwargs):
        kwargs.pop("groups", None)
        super().__init__(*args, **kwargs)


def _load_cnn_from_disk(h5_path: Path, labels_path: Path):
    """Loads via legacy Keras 2 (`tf_keras`), which is what everything in
    this app is standardised on — see app/__init__.py for why, and for the
    env var that makes app/training_pipeline.py SAVE in that same format.

    The fallback below exists only for models trained BEFORE that env var
    was added, which landed on disk in Keras 3's format (their InputLayer
    config carries a `batch_shape` key that Keras 2 rejects outright). Those
    models are otherwise perfectly good, and retraining just to change a
    serialization format would be a waste of the user's time — Keras 3 can
    still read them, and the loaded model is only ever called as
    `model(array)` further down, which behaves the same either way. Anything
    trained from now on takes the fast path and never reaches this.
    """
    try:
        model = load_model(
            str(h5_path), compile=False, custom_objects={"DepthwiseConv2D": _DepthwiseConv2DCompat}
        )
    except (TypeError, ValueError) as e:
        if "batch_shape" not in str(e):
            raise
        log.warning(
            "%s was saved in the Keras 3 format; loading it with Keras 3 instead. "
            "(Models trained from now on are saved as Keras 2 — see app/__init__.py.)",
            h5_path,
        )
        import keras  # Keras 3, independent of tf.keras's legacy routing

        model = keras.saving.load_model(str(h5_path), compile=False)

    class_names = [line.strip() for line in open(labels_path, "r").readlines() if line.strip()]
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
        # `.numpy()` on a Keras 2 / TF tensor, but a Keras 3 model (the
        # fallback path in _load_cnn_from_disk) can hand back a plain
        # ndarray depending on backend — np.asarray covers both without
        # caring which loader produced this model.
        output = model(data, training=False)
        probs = np.asarray(output.numpy() if hasattr(output, "numpy") else output)[0]
        idx = int(np.argmax(probs))
        return class_names[idx], float(probs[idx]), probs

    return classify_image


def get_hybrid_classifier(model_id: Optional[str] = None) -> HybridClassifier:
    """
    model_id: a locally-trained model's id (a subdirectory of MODELS_DIR), or
    None to use the bundled default (CNN only, no text fusion).

    A locally-trained model directory contains keras_model.h5, labels.txt,
    meta.json (fusion_alpha/fusion_alpha_per_class/keyword_rules/ocr_roi),
    and optionally text_model.joblib — exactly what
    app/training_pipeline.py writes at the end of a successful run.
    """
    if model_id is None:
        model, class_names = _get_default_cnn()
        return HybridClassifier(cnn_classify_fn=_make_cnn_classify_fn(model, class_names), class_names=class_names)

    local_dir = MODELS_DIR / model_id
    h5_path = local_dir / "keras_model.h5"
    labels_path = local_dir / "labels.txt"
    if not h5_path.exists() or not labels_path.exists():
        raise FileNotFoundError(
            f"Model '{model_id}' has no files under {MODELS_DIR / model_id}. It may have been "
            "deleted from disk while still listed in the registry — retrain it, or pick a "
            "different model for this job."
        )

    if model_id not in _cnn_cache:
        _cnn_cache[model_id] = _load_cnn_from_disk(h5_path, labels_path)
    model, class_names = _cnn_cache[model_id]

    import json

    meta = {}
    meta_path = local_dir / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())

    text_model = None
    text_model_path = local_dir / "text_model.joblib"
    if text_model_path.exists():
        if model_id not in _text_model_cache:
            _text_model_cache[model_id] = load_text_classifier(text_model_path)
        text_model = _text_model_cache[model_id]

    return HybridClassifier(
        cnn_classify_fn=_make_cnn_classify_fn(model, class_names),
        class_names=class_names,
        text_model=text_model,
        keyword_rules=meta.get("keyword_rules"),
        fusion_alpha=meta.get("fusion_alpha", 0.6),
        fusion_alpha_per_class=meta.get("fusion_alpha_per_class"),
        ocr_roi=meta.get("ocr_roi"),
    )
