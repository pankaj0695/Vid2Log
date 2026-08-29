"""
Local model training — the offline-desktop port of the cloud backend's
backend/app/services/training_pipeline.py. The ML is identical (that file's
docstring explains the *why* behind every step in detail; this one only
covers what's different here), so the models this produces are
interchangeable with the cloud ones:

  1. stratified train/val/test split (the test split is never seen during
     training or tuning),
  2. fine-tune a MobileNetV2 transfer-learning head — same backbone family
     as Teachable Machine, so the 224x224 inference path is unchanged,
  3. OCR the same images and train a TF-IDF + Logistic Regression text
     classifier over the extracted text (skipped gracefully when there
     isn't enough usable text),
  4. tune the CNN/text fusion weight (alpha) on validation,
  5. evaluate CNN-only, text-only, AND fused on the held-out test split,
  6. save both models + the report to the local registry.

What changed versus the cloud version, and why:

  * No download step. The cloud version downloads every training image from
    Cloud Storage into a temp dir, then deletes the blobs afterwards. Here
    the images are already the user's own files on their own disk, so the
    dataset is just a {action: [absolute paths]} map that gets read in
    place. Nothing is uploaded, copied to a permanent location, or deleted
    — this pipeline never mutates the user's folders.
  * SQLite instead of Firestore, so all the Firestore retry/deadline
    machinery (_FAST_RETRY, FIRESTORE_TIMEOUT_S, the "swallow progress
    write errors" helper) is gone: a local SQLite write doesn't have a
    network to fail on.
  * Runs on the same single-worker ThreadPoolExecutor as video jobs (see
    video_pipeline.py's JOB_EXECUTOR) instead of an RQ worker, so a
    training run and a video job can't fight over the CPU.

TensorFlow is still imported LAZILY inside run_training_job() rather than
at module level, for the same reason as the cloud version: a broken local
TensorFlow install should surface as a normal, visible, retryable "failed"
job with a real error message, not as an import-time crash that leaves the
job stuck at "queued" forever. `from __future__ import annotations` is what
makes the `-> tf.keras.Model` hints on the helpers below safe to write
before `tf` exists as a name.
"""
from __future__ import annotations

import json
import logging
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import train_test_split

from app.config import MODELS_DIR
from app.db import (
    get_training_job,
    insert_model,
    update_training_job,
)
from app.ml.hybrid_classifier import MIN_OCR_CHARS_FOR_FUSION
from app.ml.ocr import extract_text
from app.ml.preprocessing import resize_with_padding
from app.ml.text_classifier import predict_proba_aligned, save_text_classifier, train_text_classifier

log = logging.getLogger(__name__)

IMG_SIZE = (224, 224)
BATCH_SIZE = 16
FUSION_ALPHA_GRID = [round(a, 1) for a in np.arange(0.0, 1.01, 0.1)]

# See the cloud version's comment on PER_CLASS_OCR_EXCLUDE_MARGIN — a class
# whose OCR-only F1 trails its CNN-only F1 by more than this (or is 0) is
# excluded from fusion entirely and always routed to the CNN's own answer.
PER_CLASS_OCR_EXCLUDE_MARGIN = 0.2

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".gif", ".tif", ".tiff"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _progress(training_job_id: str, **payload) -> None:
    """Progress ping so the Flutter Train screen can show a real stage/epoch
    instead of a bare spinner. Errors are swallowed: a hiccup writing
    "epoch 4/10" must never take down an otherwise-healthy run."""
    try:
        update_training_job(training_job_id, {"progress": payload})
    except Exception:
        log.warning("[%s] Progress update %s failed — training continues.", training_job_id, payload)


def scan_dataset_folder(folder: Path) -> List[dict]:
    """Reads a folder whose SUBFOLDERS are action names, each containing that
    action's images — the layout Teachable-Machine-style datasets and the
    original Streamlit tool already use, and the fastest way to build a
    dataset on a desktop where the files are already organised. Returns one
    entry per subfolder; the caller (POST /train/scan-folder) hands this
    straight to the UI as a preview before anything is trained."""
    if not folder.is_dir():
        raise NotADirectoryError(f"Not a folder: {folder}")

    actions = []
    for child in sorted(folder.iterdir()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        images = sorted(
            str(p) for p in child.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES
        )
        if not images:
            continue
        actions.append(
            {
                "name": child.name,
                "image_count": len(images),
                "image_paths": images,
            }
        )
    return actions


def _stratified_split(
    paths_by_class: Dict[str, List[Path]], train_frac: float, val_frac: float, test_frac: float
):
    """Returns dict split_name -> list of (path, class_name), stratified per class."""
    splits: Dict[str, list] = {"train": [], "val": [], "test": []}
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
    """Copies each split's images into root/{split}/{class}/ so tf.data can
    read them by directory. These copies live in a temp dir that's deleted
    in run_training_job's `finally` — the user's own files are only ever
    read, never moved or modified.

    Filenames are made unique per copy: unlike the cloud version (whose
    downloads were already named img_0.jpg, img_1.jpg... per class), the
    source files here are arbitrary user paths, and two different folders
    can easily both contain a "Screenshot 1.png" that would otherwise
    overwrite each other in the destination."""
    for split_name, items in splits.items():
        for i, (path, class_name) in enumerate(items):
            dest_dir = root / split_name / class_name
            dest_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(path, dest_dir / f"{i}_{path.name}")


def _build_split_dataset(directory: Path, class_names: List[str], batch_size: int, shuffle: bool):
    """Loads a labeled image dataset the SAME way every other CNN caller in
    this app prepares an image — aspect-preserving resize + black-padded
    letterbox to IMG_SIZE (app/ml/preprocessing.py's resize_with_padding),
    reimplemented with tf.image ops so it runs inside a tf.data pipeline.

    Deliberately NOT tf.keras.utils.image_dataset_from_directory, which
    STRETCHES images to IMG_SIZE by default — that would train the model on
    differently-shaped pixels than inference sees. See the cloud version's
    full explanation of the bug this avoids."""
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
        # Normalize to [-1,1] here, NOT inside the model — see _build_model.
        image = (image / 127.5) - 1.0
        return image, label

    return ds.map(_load, num_parallel_calls=tf.data.AUTOTUNE).batch(batch_size)


def _build_model(num_classes: int, learning_rate: float = 1e-3):
    base = tf.keras.applications.MobileNetV2(
        input_shape=(*IMG_SIZE, 3), include_top=False, weights="imagenet", pooling="avg"
    )
    base.trainable = False  # frozen backbone: fast, small-dataset-friendly transfer learning

    # No preprocess_input layer baked in — every caller (classifier.py's
    # classify_image, _cnn_probs_for_paths below, _build_split_dataset
    # above) already normalizes to [-1,1] exactly once. Adding a layer here
    # too would normalize twice and collapse the input range, quietly
    # destroying most of the CNN's signal. See the cloud version's comment.
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
    """CNN softmax probabilities for a list of image paths, IN ORDER — so OCR
    text (extracted in the same order) pairs up exactly for fusion tuning."""
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


def _compute_ocr_excluded_classes(cnn_metrics: dict, text_metrics: dict, class_names: List[str]) -> set:
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
    """Single source of truth for combining one CNN+text prediction — used
    identically during alpha tuning, final test evaluation, and at inference
    (app/ml/hybrid_classifier.py mirrors this exact routing).

    This is a ROUTING decision, not a probability blend across excluded
    classes: if the CNN's own top guess is an excluded class, trust it
    outright and never let OCR compete against it. See the cloud version's
    comment for the subtle bug that motivated routing over blending."""
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
    model,
    cnn_only_metrics: dict,
    batch_size: int,
    training_job_id: str,
) -> Tuple[Optional[object], float, Optional[dict], Optional[dict], Optional[Dict[str, float]]]:
    """Returns (text_model, fusion_alpha, text_only_metrics, combined_metrics,
    fusion_alpha_per_class). All None/1.0 when there isn't enough usable OCR
    text to bother — the CNN result still stands on its own in that case."""
    log.info("Extracting OCR text for the text-classifier stage...")
    _progress(training_job_id, stage="extracting_text", detail="Running OCR over training images")
    train_texts, train_labels = _ocr_paths(splits["train"])
    val_texts, val_labels = _ocr_paths(splits["val"])
    test_texts, test_labels = _ocr_paths(splits["test"])

    usable_train = [(t, l) for t, l in zip(train_texts, train_labels) if len(t.strip()) >= MIN_OCR_CHARS_FOR_FUSION]
    if len(usable_train) < 2 or len({l for _, l in usable_train}) < 2:
        log.info("Not enough usable OCR text across classes — skipping text fusion, CNN-only model.")
        return None, 1.0, None, None, None

    text_model = train_text_classifier([t for t, _ in usable_train], [l for _, l in usable_train])

    test_text_pred_idx = [int(np.argmax(predict_proba_aligned(text_model, t, class_names))) for t in test_texts]
    test_true_idx = [class_names.index(l) for l in test_labels]
    text_only_metrics = _evaluate(test_true_idx, test_text_pred_idx, class_names)

    excluded = _compute_ocr_excluded_classes(cnn_only_metrics, text_only_metrics, class_names)
    if excluded:
        log.info(
            "Per-class fusion override: %s will always use the CNN's own answer directly.",
            sorted(excluded),
        )

    _progress(training_job_id, stage="tuning_fusion", detail="Tuning CNN/text fusion weight")
    val_cnn_probs = _cnn_probs_for_paths(model, [p for p, _ in splits["val"]], batch_size=batch_size)
    val_true_idx = [class_names.index(l) for l in val_labels]

    # Iterate alpha from 1.0 (CNN-only) DOWN to 0.0, overwriting only on a
    # STRICT improvement — so ties break toward trusting the CNN. With the
    # small validation splits this app is designed around, ties are the
    # common case, and a text model trained on a handful of noisy OCR
    # samples is the less robust of the two signals.
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

    fusion_alpha_per_class = {c: (1.0 if c in excluded else best_alpha) for c in class_names}

    log.info("Text fusion tuned: alpha=%.1f (val acc %.3f)", best_alpha, best_acc)
    return text_model, best_alpha, text_only_metrics, combined_metrics, fusion_alpha_per_class


def run_training_job(training_job_id: str) -> None:
    """Entry point run on video_pipeline.JOB_EXECUTOR (see submit_training_job
    in app/main.py). Everything that can fail happens inside the try block,
    so a failure always lands as a visible, retryable "failed" status rather
    than a silently stuck "queued" one."""
    job = get_training_job(training_job_id)
    if job is None:
        log.error("Training job %s not found in the local database.", training_job_id)
        return

    tmp_dir = Path(tempfile.mkdtemp(prefix=f"vid2log_train_{training_job_id}_"))

    try:
        update_training_job(
            training_job_id,
            {
                "status": "processing",
                "started_at": _now_iso(),
                "completed_at": None,
                "error": None,
                "progress": {"stage": "starting"},
            },
        )

        # Lazy import — see the module docstring. `global tf` publishes it to
        # this module's namespace so the helpers above (which Python resolves
        # at call time, not definition time) can use it normally.
        global tf
        import tensorflow as tf

        dataset: Dict[str, List[str]] = job["dataset"]
        split_cfg = job.get("split") or {"train": 0.7, "val": 0.15, "test": 0.15}
        epochs = job["epochs"]
        batch_size = job["batch_size"]
        learning_rate = job["learning_rate"]
        model_name = job["model_name"]

        # Read the user's files in place — nothing is downloaded, copied to a
        # permanent location, or deleted. A path that's since been moved or
        # renamed is a real, reportable error rather than something to skip
        # silently: training on a quietly-shrunk dataset would produce a
        # model whose metrics don't describe what the user thinks they do.
        paths_by_class: Dict[str, List[Path]] = {}
        missing: List[str] = []
        for class_name, image_paths in dataset.items():
            resolved = []
            for raw in image_paths:
                p = Path(raw)
                if not p.is_file():
                    missing.append(raw)
                else:
                    resolved.append(p)
            paths_by_class[class_name] = resolved
        if missing:
            preview = ", ".join(missing[:5])
            raise FileNotFoundError(
                f"{len(missing)} training image(s) no longer exist on disk (e.g. {preview}). "
                "Re-import the dataset folder and try again."
            )

        too_small = [c for c, p in paths_by_class.items() if len(p) < 3]
        if too_small:
            raise ValueError(
                f"These actions have fewer than 3 images: {', '.join(sorted(too_small))}. "
                "Each action needs at least 3 so it can be split into train/validation/test."
            )
        if len(paths_by_class) < 2:
            raise ValueError("Training needs at least 2 actions to tell apart.")

        log.info("[%s] Preparing %d actions...", training_job_id, len(paths_by_class))
        _progress(training_job_id, stage="preparing", detail=f"Preparing {len(paths_by_class)} actions")

        splits = _stratified_split(paths_by_class, split_cfg["train"], split_cfg["val"], split_cfg["test"])
        _materialize_split_dirs(splits, tmp_dir)

        # Alphabetical — every other part of this pipeline (splits, OCR, text
        # model, and classifier.py's labels.txt at inference) must agree on
        # this ordering for probability vectors to line up.
        class_names = sorted(paths_by_class.keys())

        train_ds = _build_split_dataset(tmp_dir / "train", class_names, batch_size, shuffle=True)
        val_ds = _build_split_dataset(tmp_dir / "val", class_names, batch_size, shuffle=False)
        test_ds = _build_split_dataset(tmp_dir / "test", class_names, batch_size, shuffle=False)

        model = _build_model(num_classes=len(class_names), learning_rate=learning_rate)

        log.info("[%s] Training CNN for %d epochs...", training_job_id, epochs)
        _progress(training_job_id, stage="training_cnn", epoch=0, epochs=epochs)

        class _ProgressCallback(tf.keras.callbacks.Callback):
            """Reports after every epoch so the Train screen can show real
            "epoch 4/10" progress. Defined here, not at module level,
            because tf.keras only exists once the lazy import has run."""

            def on_epoch_end(self, epoch, logs=None):
                logs = logs or {}

                def _f(key):
                    v = logs.get(key)
                    return float(v) if v is not None else None

                _progress(
                    training_job_id,
                    stage="training_cnn",
                    epoch=epoch + 1,
                    epochs=epochs,
                    accuracy=_f("accuracy"),
                    loss=_f("loss"),
                    val_accuracy=_f("val_accuracy"),
                )

        model.fit(train_ds, validation_data=val_ds, epochs=epochs, verbose=2, callbacks=[_ProgressCallback()])

        # ── Real held-out test-set evaluation ──
        _progress(training_job_id, stage="evaluating_cnn")
        y_true, y_pred = [], []
        for images, labels in test_ds:
            preds = model.predict(images, verbose=0)
            y_true.extend(labels.numpy().tolist())
            y_pred.extend(np.argmax(preds, axis=1).tolist())
        cnn_only_metrics = _evaluate(y_true, y_pred, class_names)

        # ── OCR text classifier + fusion ──
        text_model, fusion_alpha, text_only_metrics, combined_metrics, fusion_alpha_per_class = _train_text_stage(
            splits, class_names, model, cnn_only_metrics, batch_size, training_job_id
        )

        # ── Save into the local registry ──
        _progress(training_job_id, stage="saving_model", detail="Writing model files")
        model_id = str(uuid.uuid4())
        model_dir = MODELS_DIR / model_id
        model_dir.mkdir(parents=True, exist_ok=True)

        # This exact layout is what app/ml/classifier.py's
        # get_hybrid_classifier() already knows how to load — keras_model.h5
        # + labels.txt + meta.json (+ optional text_model.joblib).
        model.save(model_dir / "keras_model.h5")
        (model_dir / "labels.txt").write_text("\n".join(class_names))

        if text_model is not None:
            save_text_classifier(text_model, model_dir / "text_model.joblib")

        (model_dir / "meta.json").write_text(
            json.dumps(
                {
                    "model_id": model_id,
                    "name": model_name,
                    "fusion_alpha": fusion_alpha,
                    "fusion_alpha_per_class": fusion_alpha_per_class,
                    "keyword_rules": None,
                    "ocr_roi": None,
                },
                indent=2,
            )
        )

        metrics = {
            "cnn_only": cnn_only_metrics,
            "text_only": text_only_metrics,  # None when OCR text wasn't usable
            "combined": combined_metrics,  # None when OCR text wasn't usable
            "fusion_alpha": fusion_alpha,
            "fusion_alpha_per_class": fusion_alpha_per_class,
        }

        # Note there's no metrics_to_firestore() equivalent here — that
        # existed purely because Firestore rejects arrays-of-arrays, which
        # is exactly what confusion_matrix is. SQLite stores the whole
        # metrics dict as one JSON blob, so it round-trips as-is.
        insert_model(
            {
                "model_id": model_id,
                "name": model_name,
                "labels": class_names,
                "fusion_alpha": fusion_alpha,
                "fusion_alpha_per_class": fusion_alpha_per_class,
                "metrics": metrics,
                "is_active": 0,
                "dataset_version": training_job_id,
                "created_at": _now_iso(),
            }
        )

        update_training_job(
            training_job_id,
            {
                "status": "done",
                "completed_at": _now_iso(),
                "model_id": model_id,
                "metrics": metrics,
                "progress": None,
            },
        )
        log.info(
            "[%s] Training complete. Test accuracy — CNN-only: %.3f%s",
            training_job_id,
            cnn_only_metrics["accuracy"],
            f", combined: {combined_metrics['accuracy']:.3f}" if combined_metrics else " (no text fusion)",
        )

    except Exception as e:
        log.exception("[%s] Training failed", training_job_id)
        update_training_job(
            training_job_id,
            {"status": "failed", "completed_at": _now_iso(), "error": str(e)[:2000], "progress": None},
        )

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
