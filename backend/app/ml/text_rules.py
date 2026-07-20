"""
The cheapest, fastest tier of the OCR fusion: a hand-maintained list of
keywords/phrases per class (e.g. class "DayEndReport" -> ["day end report"]).
If OCR'd text fuzzy-matches one of these strongly enough, we use it directly
and skip the trained text classifier entirely — this is deliberately dumb and
deterministic, which makes it a fast way to validate "does the on-screen text
actually distinguish our classes?" before investing in a trained model, and a
useful override even after that model exists (e.g. for a brand-new class with
no training data yet, but a known, fixed header).

Stored per-model in Firestore (`models/{id}.keyword_rules`), editable via
`PATCH /models/{id}/keyword-rules` without retraining anything.
"""
from typing import Dict, List, Optional

from rapidfuzz import fuzz

DEFAULT_MATCH_THRESHOLD = 85  # 0-100; rapidfuzz partial_ratio score


def match_keyword_rules(
    text: str,
    keyword_rules: Optional[Dict[str, List[str]]],
    threshold: int = DEFAULT_MATCH_THRESHOLD,
) -> Optional[str]:
    """Returns the best-matching class name if any keyword clears the
    threshold, else None (meaning: fall through to the next tier)."""
    if not keyword_rules or not text:
        return None

    text_lower = text.lower()
    best_class, best_score = None, 0

    for class_name, keywords in keyword_rules.items():
        for keyword in keywords:
            score = fuzz.partial_ratio(keyword.lower(), text_lower)
            if score > best_score:
                best_score, best_class = score, class_name

    return best_class if best_score >= threshold else None
