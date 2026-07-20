"""
Training module — this is what replaces Teachable Machine's "no real
test-set metrics" gap, and (per the OCR-fusion methodology) additionally
trains a text classifier over OCR'd on-screen text so visually-similar UI
screens can be told apart by their text rather than by pixels alone.

Given labeled images per class (Cloud Storage blob paths), this:
  1. downloads them — and, like videos, these are TEMPORARY, but only once
     training actually SUCCEEDS: every training image gets deleted from
     Cloud Storage right after a successful run, so Cloud Storage never
     accumulates a permanent image dataset. A FAILED run deliberately keeps
     its images around (same policy as video jobs) so
     POST /train/{id}/retry can re-run the exact same dataset without
     asking the user to re-upload anything,
  2. does a STRATIFIED train/val/test split (you control the ratio; the test
     split is never seen during training or tuning),
  3. fine-tunes a MobileNetV2 transfer-learning head (same backbone family as
     Teachable Machine, so exported models stay compatible with the existing
     224x224 pipeline),
  4. OCRs the SAME images and trains a lightweight TF-IDF + Logistic
     Regression text classifier on them (skipped gracefully if there isn't
     enough usable text — some datasets just won't have it),
  5. tunes the CNN/text fusion weight (alpha) on the validation split,
  6. evaluates CNN-only, text-only, AND the fused combination on the held-out
     test set — accuracy, per-class precision/recall/F1, confusion matrix for
     each, none of which Teachable Machine exposes for any single model, let
     alone a comparison across three,
  7. saves both models + the full report to the Model Registry (Firestore
     doc + files uploaded to Cloud Storage).

This is a first working version (fixed MobileNetV2, no augmentation yet,
frozen backbone; TF-IDF + linear text model, no transformer embeddings).
Phase 3 of the plan extends this with augmentation, deeper fine-tuning, and
experiment tracking (MLflow/W&B) — the structure here is built to accommodate
that without an API change.

IMPORTANT — TensorFlow is imported LAZILY, inside run_training_job(), not at
module level. RQ resolves the "app.services.training_pipeline.run_training_job"
string reference (see queue_service.py) by importing this whole MODULE first,
INSIDE the worker process, the instant a job is dequeued — before
run_training_job()'s own body, and therefore its try/except, ever runs. A
top-level `import tensorflow as tf` would mean a broken local
TensorFlow/tensorflow-metal install crashes during that module import step,
which happens completely outside run_training_job()'s try/except — so the
Firestore job doc never gets updated to "failed" and stays stuck wherever it
was (typically "queued", since even the "processing" update never ran).
Importing it inside the function instead means a broken TensorFlow install
surfaces as a normal, visible, retryable "failed" job with a real error
message. `from __future__ import annotations` below is what makes this safe:
it defers evaluation of type hints like `-> tf.keras.Model` on the helper
functions further down, which would otherwise raise NameError at module
import time (before `tf` exists as a name at all).

The SAME reasoning applies to every other Firestore/network call in
run_training_job(), not just the TF import — the initial job_ref.get() and
the "processing" status write also live inside the try block now, because a
transient Firestore/DNS error there is otherwise just as fatal-and-silent as
a broken TF install. queue_service.py additionally configures this job with
RQ's `retry=`, so purely transient failures (a DNS blip, a momentary
Firestore outage) get retried a few times automatically before a human ever
needs to click Retry in the UI.

POST /train/{id}/retry (see routers/train.py) re-queues this SAME Firestore
document — same training_job_id — rather than creating a new one, so the
job's place in your history doesn't change across retries; only its
status/progress/error/retry_count do. Progress is reported throughout via
`_update_job()`, a best-effort (errors-swallowed) Firestore write, so the
frontend can show a real stage/epoch instead of a bare spinner.
"""
from __future__ import annotations

import logging
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from google.api_core.retry import Retry
from PIL import Image
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import train_test_split

from app.ml.hybrid_classifier import MIN_OCR_CHARS_FOR_FUSION
from app.ml.ocr import extract_text
from app.ml.preprocessing import resize_with_padding
from app.ml.text_classifier import predict_proba_aligned, save_text_classifier, train_text_classifier
from app.services import gcs_service
from app.services.firebase_service import get_db
from app.utils import metrics_to_firestore

log = logging.getLogger(__name__)

IMG_SIZE = (224, 224)
BATCH_SIZE = 16
FUSION_ALPHA_GRID = [round(a, 1) for a in np.arange(0.0, 1.01, 0.1)]

# IMPORTANT — passing `timeout=` alone to job_ref.get()/.update() does NOT
# bound how long a hung call can take. That `timeout` argument only caps
# each individual RPC ATTEMPT; the number of attempts and the TOTAL time
# spent retrying across all of them is governed separately by the `retry`
# policy object — and Firestore's default retry policy has its own baked-in
# total deadline (300s for reads via batch_get_documents, ~120s for writes
# via commit) that a per-attempt `timeout=` does nothing to shorten. This
# was tried and confirmed NOT to help: a real outage still took the full
# ~300s/~60s before raising, because only `retry=` below actually controls
# that. `_FAST_RETRY` overrides the retry policy's own total `timeout` (not
# to be confused with the per-attempt `timeout=` kwarg passed alongside it)
# so a genuine outage surfaces — and, via queue_service.py's `retry=`, gets
# automatically retried — within FIRESTORE_TIMEOUT_S seconds, not minutes.
FIRESTORE_TIMEOUT_S = 15.0
_FAST_RETRY = Retry(initial=1.0, maximum=4.0, multiplier=2.0, timeout=FIRESTORE_TIMEOUT_S)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _update_job(job_ref, **fields) -> None:
    """Best-effort Firestore update for PROGRESS reporting only — swallows
    its own errors so a transient network hiccup while pinging "epoch 4/10"
    doesn't take down an otherwise-healthy training run. The final
    status="done"/"failed" writes deliberately do NOT go through this
    helper: those need to actually succeed (or visibly fail, so RQ's retry
    mechanism in queue_service.py can take over) for the job to ever resolve."""
    try:
        job_ref.update(fields, retry=_FAST_RETRY, timeout=FIRESTORE_TIMEOUT_S)
    except Exception:
        log.warning("[%s] Progress update %s failed (transient?) — training continues.", job_ref.id, fields)


def _download_dataset(
    dataset: Dict[str, List[dict]], root: Path, storage_paths_out: List[str]
) -> Dict[str, List[Path]]:
    """dataset: class_name -> list of {"storage_path"} dicts (Firestore's
    plain-dict round-trip of TrainingImageRef). Every storage_path
    encountered is appended to `storage_paths_out` as we go — including ones
    downloaded right before a later download fails — so the caller can still
    clean up whatever was actually uploaded even on a partial failure."""
    paths_by_class: Dict[str, List[Path]] = {}
    for class_name, images in dataset.items():
        class_paths = []
        for i, image in enumerate(images):
            storage_paths_out.append(image["storage_path"])
            dest = root / "raw" / class_name / f"img_{i}.jpg"
            gcs_service.download_blob(image["storage_path"], dest)
            class_paths.append(dest)
        paths_by_class[class_name] = class_paths
    return paths_by_class


def _stratified_split(
    paths_by_class: Dict[str, List[Path]], train_frac: float, val_frac: float, test_frac: float
):
    """Returns dict split_name -> list of (path, class_name), stratified per class."""
    splits = {"train": [], "val": [], "test": []}
    for class_name, paths in paths_by_class.items():
        train_paths, temp_paths = train_test_split(paths, train_size=train_frac, random_state=42)
        remaining_frac = val_frac + test_frac
        val_share = val_frac / remaining_frac if remaining_frac > 0 else 0.5
        if len(temp_paths) >= 2:
            val_paths, test_paths = train_test_split(temp_paths, train_size=val_share, random_state=42)
        else:
            val_paths, test_paths = temp_paths, []

        splits["train"] += [(p, class_name) for p in train_paths]
        splits["val"] += [(p, class_name) for p in val_paths]
        splits["test"] += [(p, class_name) for p in test_paths]
    return splits


def _materialize_split_dirs(splits: dict, root: Path) -> None:
    for split_name, items in splits.items():
        for path, class_name in items:
            dest_dir = root / split_name / class_name
            dest_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(path, dest_dir / path.name)


def _build_split_dataset(directory: Path, class_names: List[str], batch_size: int, shuffle: bool) -> tf.data.Dataset:
    """Loads a labeled image dataset the SAME way every OTHER CNN caller in
    this app prepares an image — aspect-preserving resize + black-padded
    letterbox to IMG_SIZE, i.e. app/ml/preprocessing.py's
    resize_with_padding(), reimplemented here with tf.image ops so it can
    run inside a tf.data pipeline for training speed.

    This deliberately replaces `tf.keras.utils.image_dataset_from_directory`,
    whose default behavior STRETCHES every image to IMG_SIZE without
    preserving aspect ratio (`crop_to_aspect_ratio` defaults to False). That
    mismatch meant the model was TRAINED and evaluated for cnn_only_metrics
    on stretched images, while classifier.py's live video classification and
    _cnn_probs_for_paths's fusion-tuning/routing evaluation both use
    resize_with_padding()'s letterboxed images — two different pixel
    versions of "the same" picture. That's what caused the "Combined"
    report's per-class-routed classes to show DIFFERENT numbers than
    CNN-only's own report even once the routing logic itself was correct:
    the two reports' argmax(cnn_probs) decisions were computed from
    differently-prepared images, so they didn't agree even for a class that
    should route 1:1 to the CNN's own answer. Building every split through
    this one function is what guarantees training, cnn_only_metrics,
    fusion-alpha tuning, the Combined report, and live inference all agree
    pixel-for-pixel on how an image becomes a 224x224 array.
    """
    file_paths: List[str] = []
    label_indices: List[int] = []
    for idx, class_name in enumerate(class_names):
        class_dir = directory / class_name
        if not class_dir.is_dir():
            continue
        for p in sorted(class_dir.iterdir()):
            if p.is_file():
                file_paths.append(str(p))
                label_indices.append(idx)

    ds = tf.data.Dataset.from_tensor_slices((file_paths, label_indices))
    if shuffle:
        ds = ds.shuffle(buffer_size=max(len(file_paths), 1), reshuffle_each_iteration=True)

    def _load(path, label):
        raw = tf.io.read_file(path)
        image = tf.io.decode_image(raw, channels=3, expand_animations=False)
        image.set_shape([None, None, 3])
        image = tf.image.resize_with_pad(image, IMG_SIZE[0], IMG_SIZE[1], method="lanczos3")
        # Normalize to [-1,1] here too — see _build_model()'s comment for
        # why this can't live inside the model anymore.
        image = (image / 127.5) - 1.0
        return image, label

    return ds.map(_load, num_parallel_calls=tf.data.AUTOTUNE).batch(batch_size)


def _build_model(num_classes: int, learning_rate: float = 1e-3) -> tf.keras.Model:
    base = tf.keras.applications.MobileNetV2(
        input_shape=(*IMG_SIZE, 3), include_top=False, weights="imagenet", pooling="avg"
    )
    base.trainable = False  # frozen backbone: fast, small-dataset-friendly transfer learning

    # IMPORTANT — no preprocess_input layer baked in here. Every caller of
    # this model (classifier.py::classify_image, _cnn_probs_for_paths below)
    # ALREADY manually normalizes pixels to [-1,1] via `(arr/127.5)-1` before
    # calling the model — that convention exists to match the bundled
    # default model / Teachable Machine exports, which are plain graphs with
    # no internal preprocessing layer and expect pre-normalized input. Baking
    # `mobilenet_v2.preprocess_input` in here as well used to mean every
    # image got normalized TWICE (once by the caller, once again inside the
    # model) — `(arr/127.5-1)/127.5-1` collapses the entire [0,255] input
    # range into a barely-distinguishable sliver near -1, destroying most of
    # the CNN's actual signal. This was silently degrading BOTH real video
    # classification (classifier.py) AND every training-time evaluation that
    # goes through _cnn_probs_for_paths (fusion-alpha tuning, the "Combined"
    # report, and the per-class routing decision) — this is what was making
    # the "Combined" report's per-class numbers look inconsistent/wrong even
    # after the routing fix: the routing decision itself was being computed
    # from corrupted CNN probabilities. _build_split_dataset() above now does
    # the SAME single `(x/127.5)-1` normalization explicitly, instead of
    # relying on a layer inside the model, so there's exactly one
    # normalization step everywhere, matching what
    # classify_image()/_cnn_probs_for_paths already did.
    inputs = tf.keras.Input(shape=(*IMG_SIZE, 3))
    x = base(inputs, training=False)
    x = tf.keras.layers.Dense(128, activation="relu")(x)
    x = tf.keras.layers.Dropout(0.2)(x)
    outputs = tf.keras.layers.Dense(num_classes, activation="softmax")(x)
    model = tf.keras.Model(inputs, outputs)
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=learning_rate),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    return model


def _cnn_probs_for_paths(model, paths: List[Path], batch_size: int = BATCH_SIZE) -> np.ndarray:
    """CNN softmax probabilities for a list of image paths, IN ORDER — used so
    OCR text (extracted in the same path order) can be paired up exactly for
    fusion tuning/evaluation, independent of tf.data's own iteration order."""
    all_probs: List[np.ndarray] = []
    batch: List[np.ndarray] = []

    def flush():
        if not batch:
            return
        arr = np.stack(batch, axis=0)
        preds = model(arr, training=False).numpy()
        all_probs.extend(preds)
        batch.clear()

    for p in paths:
        img = Image.open(p).convert("RGB")
        resized = resize_with_padding(img)
        normalized = (np.asarray(resized).astype(np.float32) / 127.5) - 1
        batch.append(normalized)
        if len(batch) >= batch_size:
            flush()
    flush()
    return np.array(all_probs)


def _evaluate(y_true_idx: List[int], y_pred_idx: List[int], class_names: List[str]) -> dict:
    accuracy = float(np.mean(np.array(y_true_idx) == np.array(y_pred_idx))) if y_true_idx else 0.0
    precision, recall, f1, support = precision_recall_fscore_support(
        y_true_idx, y_pred_idx, labels=list(range(len(class_names))), zero_division=0
    )
    cm = confusion_matrix(y_true_idx, y_pred_idx, labels=list(range(len(class_names)))).tolist()
    per_class = {
        class_names[i]: {
            "precision": float(precision[i]),
            "recall": float(recall[i]),
            "f1": float(f1[i]),
            "support": int(support[i]),
        }
        for i in range(len(class_names))
    }
    return {"accuracy": accuracy, "per_class": per_class, "confusion_matrix": cm, "test_set_size": len(y_true_idx)}


def _ocr_paths(paths_with_labels: List[Tuple[Path, str]]) -> Tuple[List[str], List[str]]:
    texts, labels = [], []
    for path, class_name in paths_with_labels:
        img = Image.open(path).convert("RGB")
        texts.append(extract_text(img))  # full-resolution image — OCR before any CNN resizing
        labels.append(class_name)
    return texts, labels



# A class is excluded from OCR fusion entirely if its OCR-only F1 on the
# TEST split — bigger and more stable than the validation split used to
# tune the shared alpha below — trails its CNN-only F1 by more than this
# margin, or is 0 outright. This is a threshold on numbers already computed
# from the test set, not a second statistical fit, which matters: with the
# small per-class datasets this app is designed around (a handful of
# validation images per class is common), actually TUNING a separate value
# per class on the validation split would mostly be fitting noise — a class
# with 1 validation image doesn't give you a real measurement of "which
# model is better for this class," it gives you a coin flip. A class
# scoring 0% OCR F1 against 60%+ CNN F1 (this is what motivated the
# feature — see "Bulldozing" in the fusion-tuning-tie-break fix above) is a
# real signal worth acting on; a 5-point gap on a 2-image test class is not.
PER_CLASS_OCR_EXCLUDE_MARGIN = 0.2


def _compute_ocr_excluded_classes(cnn_metrics: dict, text_metrics: dict, class_names: List[str]) -> set:
    """Classes where OCR is judged unreliable enough that it shouldn't get a
    vote at all when the CNN's own top guess is one of them. See
    PER_CLASS_OCR_EXCLUDE_MARGIN's comment for the rule and why it's a
    threshold rather than a per-class tuning pass."""
    excluded = set()
    for c in class_names:
        cnn_f1 = cnn_metrics["per_class"].get(c, {}).get("f1", 0.0)
        text_f1 = text_metrics["per_class"].get(c, {}).get("f1", 0.0)
        if text_f1 == 0.0 or text_f1 < cnn_f1 - PER_CLASS_OCR_EXCLUDE_MARGIN:
            excluded.add(c)
    return excluded


def _fuse_one(
    cnn_probs: np.ndarray, text_probs: Optional[np.ndarray], alpha: float, class_names: List[str], excluded: set
) -> int:
    """Single source of truth for how one CNN+text prediction gets combined —
    used identically during alpha-tuning, final test-set evaluation, AND at
    inference (app/ml/hybrid_classifier.py mirrors this exact routing).

    IMPORTANT — this is a ROUTING decision, not a probability blend across
    excluded classes. An earlier version computed a per-class alpha VECTOR
    (alpha=1.0 just for excluded classes, the shared alpha elsewhere) and
    blended element-wise before taking one argmax over the result. That
    looked reasonable but was actually broken: excluded classes' scores
    became pure CNN softmax values while every other class's score stayed
    pure text-classifier output (whenever the shared alpha was 0, which the
    tie-break fix above still allows if OCR genuinely wins the val split) —
    and a small linear text classifier tends to be overconfident even when
    wrong, so those other classes' inflated scores beat even a CORRECTLY
    CNN-classified excluded-class frame in the argmax. The fix: decide
    whether to fuse AT ALL based on what the CNN itself already thinks this
    frame is — if the CNN's own top guess is an excluded class, trust it
    outright and never let OCR compete against it; otherwise fall back to
    the normal single shared-alpha blend across the whole vector, exactly
    like before per-class routing existed. This never compares scores
    computed on two different bases against each other.
    """
    cnn_idx = int(np.argmax(cnn_probs))
    if class_names[cnn_idx] in excluded:
        return cnn_idx
    if text_probs is None:
        return cnn_idx
    combined = alpha * cnn_probs + (1 - alpha) * text_probs
    return int(np.argmax(combined))


def _train_text_stage(
    splits: dict,
    class_names: List[str],
    model: tf.keras.Model,
    cnn_only_metrics: dict,
    batch_size: int = BATCH_SIZE,
    job_ref=None,
) -> Tuple[Optional[object], float, Optional[dict], Optional[dict], Optional[Dict[str, float]]]:
    """Returns (text_model, fusion_alpha, text_only_metrics, combined_metrics,
    fusion_alpha_per_class). All None/1.0 if there isn't enough usable OCR
    text to bother — the CNN result still stands on its own in that case."""
    log.info("Extracting OCR text for the text-classifier stage...")
    if job_ref is not None:
        _update_job(job_ref, progress={"stage": "extracting_text", "detail": "Running OCR over training images"})
    train_texts, train_labels = _ocr_paths(splits["train"])
    val_texts, val_labels = _ocr_paths(splits["val"])
    test_texts, test_labels = _ocr_paths(splits["test"])

    usable_train = [(t, l) for t, l in zip(train_texts, train_labels) if len(t.strip()) >= MIN_OCR_CHARS_FOR_FUSION]
    if len(usable_train) < 2 or len({l for _, l in usable_train}) < 2:
        log.info("Not enough usable OCR text across classes — skipping text fusion, CNN-only model.")
        return None, 1.0, None, None, None

    text_model = train_text_classifier([t for t, _ in usable_train], [l for _, l in usable_train])

    # Text-only metrics on the test split (its own standalone report).
    test_text_pred_idx = [
        int(np.argmax(predict_proba_aligned(text_model, t, class_names))) for t in test_texts
    ]
    test_true_idx = [class_names.index(l) for l in test_labels]
    text_only_metrics = _evaluate(test_true_idx, test_text_pred_idx, class_names)

    # Which classes OCR doesn't get a vote for at all — computed from TEST
    # metrics (bigger, more stable than validation) BEFORE tuning the shared
    # alpha below, so the tuning loop itself already routes around them
    # instead of tuning against a metric that per-class routing will later
    # override anyway. See PER_CLASS_OCR_EXCLUDE_MARGIN's comment.
    excluded = _compute_ocr_excluded_classes(cnn_only_metrics, text_only_metrics, class_names)
    if excluded:
        log.info(
            "Per-class fusion override: %s will always use the CNN's own answer directly "
            "(OCR F1 far below CNN F1 for these classes) — never fused/competed against OCR.",
            sorted(excluded),
        )

    # Tune the fusion weight on the validation split (never touches test).
    if job_ref is not None:
        _update_job(job_ref, progress={"stage": "tuning_fusion", "detail": "Tuning CNN/text fusion weight"})
    val_cnn_probs = _cnn_probs_for_paths(model, [p for p, _ in splits["val"]], batch_size=batch_size)
    val_true_idx = [class_names.index(l) for l in val_labels]

    # Iterate the grid from alpha=1.0 (CNN-only) DOWN to 0.0 (text-only), and
    # only overwrite the running best on a STRICT improvement. That combo
    # means ties break toward the highest alpha tried so far — i.e. toward
    # trusting the CNN more. This matters a lot with small validation splits
    # (common here — a handful of images per class): accuracy only moves in
    # coarse steps of 1/len(val), so multiple alpha values tying on the exact
    # same validation accuracy is the common case, not a rare edge case.
    # Iterating low-to-high (the original order) meant ties silently landed
    # on alpha=0.0 — "ignore the CNN entirely" — purely because 0.0 was
    # tried first, even when a CNN-leaning blend would have generalized just
    # as well. Breaking ties toward the CNN instead is the safer default: an
    # OCR text classifier trained on a handful of noisy on-screen-text
    # samples per class is generally the less robust of the two signals.
    best_alpha, best_acc = 1.0, -1.0
    for alpha in sorted(FUSION_ALPHA_GRID, reverse=True):
        preds = []
        for i, text in enumerate(val_texts):
            text_probs = (
                predict_proba_aligned(text_model, text, class_names)
                if len(text.strip()) >= MIN_OCR_CHARS_FOR_FUSION
                else None
            )
            preds.append(_fuse_one(val_cnn_probs[i], text_probs, alpha, class_names, excluded))
        acc = float(np.mean(np.array(preds) == np.array(val_true_idx)))
        if acc > best_acc:
            best_acc, best_alpha = acc, alpha

    # Combined (fused) metrics on the held-out test split, using the exact
    # same _fuse_one() routing logic that's deployed at inference (see
    # hybrid_classifier.py) — so this report always reflects what the model
    # will actually do, not a different, blend-only version of it.
    test_cnn_probs = _cnn_probs_for_paths(model, [p for p, _ in splits["test"]], batch_size=batch_size)
    combined_pred_idx = []
    for i, text in enumerate(test_texts):
        text_probs = (
            predict_proba_aligned(text_model, text, class_names)
            if len(text.strip()) >= MIN_OCR_CHARS_FOR_FUSION
            else None
        )
        combined_pred_idx.append(_fuse_one(test_cnn_probs[i], text_probs, best_alpha, class_names, excluded))
    combined_metrics = _evaluate(test_true_idx, combined_pred_idx, class_names)

    # Stored/reported per-class alpha — 1.0 for excluded (routing) classes,
    # the shared tuned alpha for everything else. Kept as a full per-class
    # dict for the API/UI contract, even though the actual decision logic
    # is now the routing rule in _fuse_one(), not a probability blend.
    fusion_alpha_per_class = {c: (1.0 if c in excluded else best_alpha) for c in class_names}

    log.info(
        "Text fusion tuned: alpha=%.1f (val acc %.3f) — test accuracy CNN-only vs text-only vs combined below.",
        best_alpha, best_acc,
    )
    return text_model, best_alpha, text_only_metrics, combined_metrics, fusion_alpha_per_class


def run_training_job(training_job_id: str) -> None:
    """Entry point called by the RQ worker for `training` jobs.

    Everything that touches Firestore or the network — including the very
    first read of the job doc — happens INSIDE the try block below. That's
    deliberate: this used to fetch the doc and write "processing" before the
    try block even started, which meant a transient Firestore/network error
    right there (seen in practice: a DNS resolution blip talking to
    firestore.googleapis.com) crashed the RQ job with nothing ever written
    back — the job stayed stuck at "queued" forever with no visible error
    and no way to retry from the UI. Now that same error is caught, recorded
    as a normal "failed" status with a real error message, and (via the
    `retry=` on the queue in queue_service.py) automatically retried a few
    times by RQ itself before a human ever needs to click Retry."""
    db = get_db()
    job_ref = db.collection("training_jobs").document(training_job_id)
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"vid2log_train_{training_job_id}_"))
    # Every training image is only ever needed for the duration of this job —
    # same "temporary" treatment as videos. We collect storage paths as we
    # download (see _download_dataset) so the cleanup below can delete all
    # of them from Cloud Storage regardless of how the job ends.
    uploaded_image_storage_paths: List[str] = []

    try:
        job = job_ref.get(retry=_FAST_RETRY, timeout=FIRESTORE_TIMEOUT_S)
        if not job.exists:
            log.error("Training job %s not found in Firestore.", training_job_id)
            return
        data = job.to_dict()

        # Clear out anything left over from a previous attempt — POST
        # /train/{id}/retry re-queues this SAME document (same training_job_id)
        # rather than creating a new one, so a stale error/metrics/progress
        # from the run that just failed must not linger and look current.
        job_ref.update(
            {
                "status": "processing",
                "started_at": _now_iso(),
                "completed_at": None,
                "error": None,
                "progress": {"stage": "starting"},
            },
            retry=_FAST_RETRY,
            timeout=FIRESTORE_TIMEOUT_S,
        )

        # See the module docstring — this MUST stay inside the try block,
        # not hoisted to module level. `global tf` publishes it to the
        # module's namespace so the helper functions further down
        # (_build_model, _cnn_probs_for_paths, _train_text_stage, all called
        # only after this point) can resolve `tf` normally — Python looks up
        # globals at call time, not at function-definition time, so this
        # works even though those functions were defined before `tf` existed.
        global tf
        import tensorflow as tf

        dataset = data["dataset"]
        split_cfg = data.get("split", {"train": 0.7, "val": 0.15, "test": 0.15})
        epochs = data.get("epochs", 20)
        batch_size = data.get("batch_size", BATCH_SIZE)
        learning_rate = data.get("learning_rate", 1e-3)
        model_name = data.get("model_name", f"model-{training_job_id[:8]}")
        keyword_rules = data.get("keyword_rules")

        log.info("[%s] Downloading %d classes...", training_job_id, len(dataset))
        _update_job(job_ref, progress={"stage": "downloading", "detail": f"Downloading {len(dataset)} classes"})
        paths_by_class = _download_dataset(dataset, tmp_dir, uploaded_image_storage_paths)

        splits = _stratified_split(paths_by_class, split_cfg["train"], split_cfg["val"], split_cfg["test"])
        _materialize_split_dirs(splits, tmp_dir)

        # Alphabetical, matching what `image_dataset_from_directory` used to
        # assign automatically — every other piece of this pipeline (splits,
        # OCR, text model) must agree on this same ordering for probability
        # vectors to line up.
        class_names = sorted(paths_by_class.keys())

        # See _build_split_dataset()'s docstring: this loads + resizes +
        # normalizes every image identically to how classify_image() and
        # _cnn_probs_for_paths() do it (letterboxed, not stretched), so
        # training, cnn_only_metrics, fusion tuning, the Combined report, and
        # live inference all agree pixel-for-pixel.
        train_ds = _build_split_dataset(tmp_dir / "train", class_names, batch_size, shuffle=True)
        val_ds = _build_split_dataset(tmp_dir / "val", class_names, batch_size, shuffle=False)
        test_ds = _build_split_dataset(tmp_dir / "test", class_names, batch_size, shuffle=False)

        model = _build_model(num_classes=len(class_names), learning_rate=learning_rate)

        log.info("[%s] Training CNN for %d epochs...", training_job_id, epochs)
        _update_job(job_ref, progress={"stage": "training_cnn", "epoch": 0, "epochs": epochs})

        class _ProgressCallback(tf.keras.callbacks.Callback):
            """Pings Firestore after every epoch so the frontend can show
            real "epoch 4/10" progress instead of a bare spinner. Defined
            here (not at module level) because tf.keras only exists once
            the lazy import above has run."""

            def on_epoch_end(self, epoch, logs=None):
                logs = logs or {}

                def _f(key):
                    v = logs.get(key)
                    return float(v) if v is not None else None

                _update_job(
                    job_ref,
                    progress={
                        "stage": "training_cnn",
                        "epoch": epoch + 1,
                        "epochs": epochs,
                        "accuracy": _f("accuracy"),
                        "loss": _f("loss"),
                        "val_accuracy": _f("val_accuracy"),
                    },
                )

        model.fit(train_ds, validation_data=val_ds, epochs=epochs, verbose=2, callbacks=[_ProgressCallback()])

        # ── Real test-set evaluation (the thing Teachable Machine can't do) ──
        _update_job(job_ref, progress={"stage": "evaluating_cnn"})
        y_true, y_pred = [], []
        for images, labels in test_ds:
            preds = model.predict(images, verbose=0)
            y_true.extend(labels.numpy().tolist())
            y_pred.extend(np.argmax(preds, axis=1).tolist())
        cnn_only_metrics = _evaluate(y_true, y_pred, class_names)

        # ── OCR text classifier + fusion (the visually-similar-screens fix) ──
        text_model, fusion_alpha, text_only_metrics, combined_metrics, fusion_alpha_per_class = _train_text_stage(
            splits, class_names, model, cnn_only_metrics, batch_size=batch_size, job_ref=job_ref
        )
        _update_job(job_ref, progress={"stage": "saving_model", "detail": "Uploading model artifacts"})

        # Save + upload the CNN
        model_path = tmp_dir / "keras_model.h5"
        model.save(model_path)
        model_id = str(uuid.uuid4())
        upload_result = gcs_service.upload_file(str(model_path), blob_path=f"models/{model_id}/keras_model.h5")

        text_model_storage_path = None
        if text_model is not None:
            text_model_path = tmp_dir / "text_model.joblib"
            save_text_classifier(text_model, text_model_path)
            text_upload_result = gcs_service.upload_file(
                str(text_model_path), blob_path=f"models/{model_id}/text_model.joblib"
            )
            text_model_storage_path = text_upload_result["path"]

        metrics = {
            "cnn_only": cnn_only_metrics,
            "text_only": text_only_metrics,  # None if OCR text wasn't usable
            "combined": combined_metrics,  # None if OCR text wasn't usable
            "fusion_alpha": fusion_alpha,
            # None if OCR text wasn't usable at all; otherwise one entry per
            # class — 1.0 means that class is forced CNN-only (OCR judged
            # unreliable for it), anything else is the shared tuned alpha.
            # See PER_CLASS_OCR_EXCLUDE_MARGIN above for the exact rule.
            "fusion_alpha_per_class": fusion_alpha_per_class,
        }

        # Firestore rejects arrays-of-arrays ("Property metrics contains an
        # invalid nested entity") — confusion_matrix is a List[List[int]],
        # exactly that shape. metrics_to_firestore() rewrites it into an
        # array of {"row": [...]} maps, which Firestore accepts; the API
        # layer (routers/models.py, routers/train.py) converts it back to
        # plain number[][] via metrics_from_firestore() before it ever
        # reaches the frontend, so nothing downstream of the API needs to
        # know about this storage-only detail.
        firestore_metrics = metrics_to_firestore(metrics)

        db.collection("models").document(model_id).set(
            {
                "model_id": model_id,
                "name": model_name,
                "labels": class_names,
                "model_storage_path": upload_result["path"],
                "text_model_storage_path": text_model_storage_path,
                "fusion_alpha": fusion_alpha,
                # Top-level (not just inside `metrics`) because this is what
                # app/ml/classifier.py reads at INFERENCE time, mirroring
                # fusion_alpha's own duplication for the same reason.
                "fusion_alpha_per_class": fusion_alpha_per_class,
                "keyword_rules": keyword_rules,
                "metrics": firestore_metrics,
                "dataset_version": training_job_id,
                "is_active": False,
                "created_at": _now_iso(),
            }
        )

        job_ref.update(
            {
                "status": "done",
                "completed_at": _now_iso(),
                "model_id": model_id,
                "metrics": firestore_metrics,
                "progress": None,
            },
            retry=_FAST_RETRY,
            timeout=FIRESTORE_TIMEOUT_S,
        )
        log.info(
            "[%s] Training complete. Test accuracy — CNN-only: %.3f%s",
            training_job_id,
            cnn_only_metrics["accuracy"],
            f", combined: {combined_metrics['accuracy']:.3f}" if combined_metrics else " (no text fusion)",
        )

        # Only delete the source training images from Cloud Storage once
        # training has actually SUCCEEDED — same policy as video cleanup.
        # A failed job keeps its images around so POST /train/{id}/retry can
        # re-run with the exact same dataset without asking the user to
        # re-upload anything. delete_blob() already catches/logs its own
        # failures and returns False rather than raising.
        for storage_path in uploaded_image_storage_paths:
            gcs_service.delete_blob(storage_path)

    except Exception as e:
        log.exception("[%s] Training failed", training_job_id)
        try:
            job_ref.update(
                {"status": "failed", "completed_at": _now_iso(), "error": str(e)[:2000], "progress": None},
                retry=_FAST_RETRY,
                timeout=FIRESTORE_TIMEOUT_S,
            )
        except Exception:
            # We couldn't even record the failure (Firestore itself is the
            # thing that's down, e.g. the DNS blip this comment is here
            # because of). Re-raise so RQ sees this job as failed and its
            # own `retry=` (queue_service.py) can pick it up again shortly —
            # swallowing this would leave the doc stuck at "processing"
            # forever with no way for anyone, human or automatic, to notice.
            log.error(
                "[%s] Also failed to write the 'failed' status to Firestore — "
                "leaving this to RQ's automatic retry.",
                training_job_id,
            )
            raise

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
