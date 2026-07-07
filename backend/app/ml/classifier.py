"""
Loads a MobileNet-based classifier (either the bundled default model, or a
model pulled from the Model Registry / Cloudinary) and exposes a single
`classify_image(image) -> (class_name, confidence)` function per model.

This mirrors streamlit_application/video_processor.py's preprocessing exactly
(224x224 resize-with-padding, /127.5 - 1 normalization) so results are
consistent with the existing Streamlit app during the migration.
"""
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image
from tf_keras.layers import DepthwiseConv2D
from tf_keras.models import load_model

from app.utils import download_file

log = logging.getLogger(__name__)

_DEFAULT_MODEL_DIR = Path(__file__).parent / "default_model"
_CACHE_DIR = Path("/tmp/vid2log_models")

# In-process cache: model_id -> (model, class_names)
_model_cache: Dict[str, Tuple[object, List[str]]] = {}


class _DepthwiseConv2DCompat(DepthwiseConv2D):
    """Some older Teachable Machine exports include a `groups` kwarg that
    newer Keras versions reject — strip it, same fix as the Streamlit app."""

    def __init__(self, *args, **kwargs):
        kwargs.pop("groups", None)
        super().__init__(*args, **kwargs)


def _load_from_disk(h5_path: Path, labels_path: Path):
    model = load_model(
        str(h5_path), compile=False, custom_objects={"DepthwiseConv2D": _DepthwiseConv2DCompat}
    )
    class_names = [line.strip() for line in open(labels_path, "r").readlines()]
    return model, class_names


def _get_default() -> Tuple[object, List[str]]:
    if "__default__" not in _model_cache:
        log.info("Loading default bundled model from %s", _DEFAULT_MODEL_DIR)
        _model_cache["__default__"] = _load_from_disk(
            _DEFAULT_MODEL_DIR / "keras_model.h5", _DEFAULT_MODEL_DIR / "labels.txt"
        )
    return _model_cache["__default__"]


def get_classifier(
    model_id: Optional[str] = None,
    cloudinary_model_url: Optional[str] = None,
    labels: Optional[List[str]] = None,
):
    """
    Returns (classify_fn, class_names) for the requested model.

    - model_id=None -> the bundled default model (what the Streamlit app uses today).
    - model_id + cloudinary_model_url + labels -> downloads (once) and caches
      that model's .h5 from Cloudinary, then loads it.
    """
    if model_id is None:
        model, class_names = _get_default()
    else:
        if model_id not in _model_cache:
            if not cloudinary_model_url or not labels:
                raise ValueError(
                    f"Model '{model_id}' is not cached and no cloudinary_model_url/labels "
                    "were provided to fetch it."
                )
            local_dir = _CACHE_DIR / model_id
            h5_path = local_dir / "keras_model.h5"
            if not h5_path.exists():
                log.info("Downloading model %s from Cloudinary...", model_id)
                download_file(cloudinary_model_url, h5_path)
            labels_path = local_dir / "labels.txt"
            labels_path.write_text("\n".join(labels))
            _model_cache[model_id] = _load_from_disk(h5_path, labels_path)
        model, class_names = _model_cache[model_id]

    def classify_image(image: Image.Image) -> Tuple[str, float]:
        resized = _resize_with_padding(image)
        arr = np.asarray(resized).astype(np.float32)
        normalized = (arr / 127.5) - 1
        data = np.expand_dims(normalized, axis=0)
        prediction = model(data, training=False).numpy()
        idx = int(np.argmax(prediction))
        return class_names[idx], float(np.max(prediction))

    return classify_image, class_names


def _resize_with_padding(img: Image.Image, output_size=(224, 224), pad_color=(0, 0, 0)) -> Image.Image:
    original_width, original_height = img.size
    target_width, target_height = output_size
    scale = min(target_width / original_width, target_height / original_height)
    new_width = int(original_width * scale)
    new_height = int(original_height * scale)
    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    padded = Image.new("RGB", (target_width, target_height), pad_color)
    x_offset = (target_width - new_width) // 2
    y_offset = (target_height - new_height) // 2
    padded.paste(img, (x_offset, y_offset))
    return padded
