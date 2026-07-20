"""
OCR text extraction — the input to both the keyword-rule override and the
trained text classifier in the CNN+text fusion pipeline (see
app/ml/hybrid_classifier.py for how this gets combined with the CNN).

IMPORTANT: always run this on the ORIGINAL frame, before it gets resized down
to 224x224 for the CNN (app/ml/preprocessing.resize_with_padding) — shrinking
first destroys small UI text before OCR ever sees it.
"""
import logging
from typing import Optional, Tuple

import pytesseract
from PIL import Image, ImageOps

log = logging.getLogger(__name__)

# If your UI's distinguishing text (title/header) always sits in the same
# screen location, set this per-model to crop before OCR — faster and far
# more accurate than OCR'ing the whole frame with game/app graphics as noise.
# Format: (left, top, right, bottom) in pixels, relative to the ORIGINAL frame.
RoiBox = Tuple[int, int, int, int]


def _preprocess_for_ocr(image: Image.Image, roi: Optional[RoiBox] = None, upscale: float = 2.0) -> Image.Image:
    img = image
    if roi:
        img = img.crop(roi)
    if upscale and upscale != 1.0:
        w, h = img.size
        img = img.resize((max(1, int(w * upscale)), max(1, int(h * upscale))), Image.Resampling.LANCZOS)
    img = ImageOps.grayscale(img)
    img = ImageOps.autocontrast(img)
    return img


def extract_text(
    image: Image.Image,
    roi: Optional[RoiBox] = None,
    upscale: float = 2.0,
    tesseract_config: str = "--psm 6",
) -> str:
    """Best-effort OCR — returns "" (never raises) on any Tesseract failure,
    so a bad frame degrades to the CNN-only path rather than crashing a job."""
    try:
        processed = _preprocess_for_ocr(image, roi=roi, upscale=upscale)
        text = pytesseract.image_to_string(processed, config=tesseract_config)
        return text.strip()
    except Exception:
        log.warning("OCR extraction failed for a frame; continuing without text.", exc_info=True)
        return ""
