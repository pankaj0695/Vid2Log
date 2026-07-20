"""
Combines the CNN (MobileNetV2) prediction with OCR-extracted on-screen text
to handle screens that look visually similar but differ mainly in their text
(headers, labels, titles) — see the project plan's OCR fusion methodology.

Two-tier design, for performance as much as accuracy:

  - classify_frame(): CNN only. Cheap (a few ms), called on EVERY sampled
    frame purely to detect *candidate* scene transitions — same as before
    OCR fusion existed.
  - verify_transition(): OCR + keyword rules + trained text classifier +
    fusion. Expensive (OCR is 10-50x slower than a CNN forward pass), so it's
    only called when classify_frame() suggests the scene might have changed.
    That turns O(frames) OCR calls into roughly O(scenes) — the difference
    between "fine at 2fps across many parallel videos" and "not fine".

Bonus effect: verify_transition() can also *reject* a transition (if OCR/text
disagrees with a one-frame CNN flicker), which suppresses false scene splits
that pure-CNN classification was prone to.
"""
import logging
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

from app.ml import ocr, text_rules
from app.ml.ocr import RoiBox

log = logging.getLogger(__name__)

# Below this many OCR'd characters, we don't trust the text classifier enough
# to let it vote in the fusion — falls back to CNN-only instead of fusing
# with what's essentially noise.
MIN_OCR_CHARS_FOR_FUSION = 3

ClassifyFn = Callable[[Image.Image], Tuple[str, float, np.ndarray]]


@dataclass
class HybridClassifier:
    cnn_classify_fn: ClassifyFn
    class_names: List[str]
    text_model: Optional[object] = None  # sklearn Pipeline, or None
    keyword_rules: Optional[Dict[str, List[str]]] = None
    fusion_alpha: float = 0.6  # weight on the CNN when both signals are used
    # Per-class ROUTING override — e.g. {"Bulldozing": 1.0} means: whenever
    # the CNN's OWN top guess for a frame is "Bulldozing", trust that guess
    # directly and don't let OCR compete against it at all (set when OCR was
    # judged unreliable for that class during training — see
    # training_pipeline.py::_compute_ocr_excluded_classes). Any class not in
    # this dict (or the dict being None/empty) uses the normal shared-alpha
    # blend below. This is deliberately NOT "blend this class's own score at
    # a different weight" — see verify_transition()'s comment for why a
    # per-class probability blend doesn't actually work.
    fusion_alpha_per_class: Optional[Dict[str, float]] = None
    ocr_roi: Optional[RoiBox] = None

    def classify_frame(self, image: Image.Image) -> Tuple[str, float, np.ndarray]:
        """Cheap path — called on every sampled frame."""
        return self.cnn_classify_fn(image)

    def verify_transition(
        self,
        image: Image.Image,
        cnn_label: str,
        cnn_confidence: float,
        cnn_probs: np.ndarray,
    ) -> Tuple[str, float, dict]:
        """Expensive path — only called when the CNN suggests a scene change.
        Returns (final_label, final_confidence, debug_meta)."""
        meta = {"cnn_label": cnn_label, "cnn_confidence": cnn_confidence, "source": "cnn"}

        text = ocr.extract_text(image, roi=self.ocr_roi)
        meta["ocr_text"] = text

        # Tier 1: deterministic keyword override.
        rule_label = text_rules.match_keyword_rules(text, self.keyword_rules)
        if rule_label:
            meta["source"] = "keyword_rule"
            return rule_label, 0.99, meta

        # Tier 2a: per-class routing override. If the CNN's OWN top guess is
        # a class OCR was judged unreliable for, trust that guess directly —
        # do NOT let it enter a probability blend against other classes'
        # (possibly overconfident) text-classifier scores. This mirrors
        # training_pipeline.py's _fuse_one() exactly, which is what the
        # "Combined" training report is computed with — an earlier version
        # blended per-class alpha WEIGHTS instead of routing the decision,
        # which looked reasonable but was actually broken: an excluded
        # class's score became a raw CNN softmax value while every other
        # class kept using the shared alpha's (possibly very low, possibly
        # 0) weight on the CNN — so a confidently-wrong text-classifier
        # score for some OTHER class could still beat even a CORRECT CNN
        # prediction for the excluded class in the argmax. Routing avoids
        # that by never comparing scores computed on different bases.
        if self.fusion_alpha_per_class:
            cnn_top_idx = int(np.argmax(cnn_probs))
            if self.fusion_alpha_per_class.get(self.class_names[cnn_top_idx], self.fusion_alpha) >= 1.0:
                meta["source"] = "cnn_per_class_override"
                return self.class_names[cnn_top_idx], float(cnn_probs[cnn_top_idx]), meta

        # Tier 2b: trained text classifier, fused with the CNN via the single
        # shared alpha (only reached for classes NOT routed away above).
        if self.text_model is not None and len(text) >= MIN_OCR_CHARS_FOR_FUSION:
            from app.ml.text_classifier import predict_proba_aligned

            text_probs = predict_proba_aligned(self.text_model, text, self.class_names)
            combined = self.fusion_alpha * cnn_probs + (1 - self.fusion_alpha) * text_probs
            idx = int(np.argmax(combined))
            meta["source"] = "fusion"
            meta["text_label"] = self.class_names[int(np.argmax(text_probs))]
            return self.class_names[idx], float(combined[idx]), meta

        # Tier 3: not enough signal from OCR — trust the CNN.
        return cnn_label, cnn_confidence, meta
