"""
The trained tier of the OCR fusion: a small TF-IDF + Logistic Regression
classifier over OCR'd frame text. Deliberately lightweight (no transformer
embeddings) — screen-recording UI text is small-vocabulary and fairly
formulaic, so a linear model over TF-IDF features is normally enough, trains
in seconds, and needs far less data than a deep text model.
"""
from pathlib import Path
from typing import List

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

try:
    import joblib
except ImportError:  # scikit-learn pulls joblib in as a dependency anyway
    from sklearn.externals import joblib  # type: ignore


def train_text_classifier(texts: List[str], labels: List[str]) -> Pipeline:
    pipeline = Pipeline(
        [
            ("tfidf", TfidfVectorizer(lowercase=True, ngram_range=(1, 2), min_df=1)),
            ("clf", LogisticRegression(max_iter=1000)),
        ]
    )
    pipeline.fit(texts, labels)
    return pipeline


def predict_proba_aligned(pipeline: Pipeline, text: str, class_names: List[str]) -> np.ndarray:
    """Predicts a probability vector aligned to `class_names`' order (0 for
    any class the text classifier never saw during training), so it can be
    combined directly with the CNN's softmax output."""
    probs = pipeline.predict_proba([text])[0]
    model_classes = list(pipeline.classes_)
    aligned = np.zeros(len(class_names), dtype=np.float32)
    for i, class_name in enumerate(class_names):
        if class_name in model_classes:
            aligned[i] = probs[model_classes.index(class_name)]
    return aligned


def save_text_classifier(pipeline: Pipeline, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(pipeline, path)


def load_text_classifier(path: Path) -> Pipeline:
    return joblib.load(path)
