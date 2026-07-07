"""
Training module — this is what replaces Teachable Machine's "no real
test-set metrics" gap.

Given labeled images per class (Cloudinary URLs), this:
  1. downloads them,
  2. does a STRATIFIED train/val/test split (you control the ratio; the test
     split is never seen during training or tuning),
  3. fine-tunes a MobileNetV2 transfer-learning head (same backbone family as
     Teachable Machine, so exported models stay compatible with the existing
     224x224 pipeline),
  4. evaluates on the held-out test set and computes accuracy, per-class
     precision/recall/F1, and a confusion matrix — none of which Teachable
     Machine exposes,
  5. saves the model + writes it, and the full metrics report, to the Model
     Registry (Firestore doc + .h5 uploaded to Cloudinary).

This is a first working version (fixed MobileNetV2, no augmentation yet,
frozen backbone). Phase 3 of the plan extends this with augmentation,
fine-tuning deeper layers, and experiment tracking (MLflow/W&B) — the
structure here is built to accommodate that without an API change.
"""
import logging
import shutil
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

import numpy as np
import tensorflow as tf
from sklearn.metrics import confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import train_test_split

from app.services import cloudinary_service
from app.services.firebase_service import get_db
from app.utils import download_file

log = logging.getLogger(__name__)

IMG_SIZE = (224, 224)
BATCH_SIZE = 16


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _download_dataset(dataset: Dict[str, List[str]], root: Path) -> Dict[str, List[Path]]:
    """dataset: class_name -> list of Cloudinary image URLs."""
    paths_by_class: Dict[str, List[Path]] = {}
    for class_name, urls in dataset.items():
        class_paths = []
        for i, url in enumerate(urls):
            dest = root / "raw" / class_name / f"img_{i}.jpg"
            download_file(url, dest)
            class_paths.append(dest)
        paths_by_class[class_name] = class_paths
    return paths_by_class


def _stratified_split(
    paths_by_class: Dict[str, List[Path]], train_frac: float, val_frac: float, test_frac: float
):
    """Returns dict split_name -> list of (path, class_name), stratified per class."""
    splits = {"train": [], "val": [], "test": []}
    for class_name, paths in paths_by_class.items():
        train_paths, temp_paths = train_test_split(
            paths, train_size=train_frac, random_state=42
        )
        # split remaining between val/test proportionally
        remaining_frac = val_frac + test_frac
        val_share = val_frac / remaining_frac if remaining_frac > 0 else 0.5
        if len(temp_paths) >= 2:
            val_paths, test_paths = train_test_split(
                temp_paths, train_size=val_share, random_state=42
            )
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


def _build_model(num_classes: int) -> tf.keras.Model:
    base = tf.keras.applications.MobileNetV2(
        input_shape=(*IMG_SIZE, 3), include_top=False, weights="imagenet", pooling="avg"
    )
    base.trainable = False  # frozen backbone: fast, small-dataset-friendly transfer learning

    inputs = tf.keras.Input(shape=(*IMG_SIZE, 3))
    x = tf.keras.applications.mobilenet_v2.preprocess_input(inputs)
    x = base(x, training=False)
    x = tf.keras.layers.Dense(128, activation="relu")(x)
    x = tf.keras.layers.Dropout(0.2)(x)
    outputs = tf.keras.layers.Dense(num_classes, activation="softmax")(x)
    model = tf.keras.Model(inputs, outputs)
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=1e-3),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"],
    )
    return model


def run_training_job(training_job_id: str) -> None:
    """Entry point called by the RQ worker for `training` jobs."""
    db = get_db()
    job_ref = db.collection("training_jobs").document(training_job_id)
    job = job_ref.get()
    if not job.exists:
        log.error("Training job %s not found in Firestore.", training_job_id)
        return

    data = job.to_dict()
    job_ref.update({"status": "processing", "started_at": _now_iso()})

    tmp_dir = Path(tempfile.mkdtemp(prefix=f"vid2log_train_{training_job_id}_"))

    try:
        dataset = data["dataset"]
        split_cfg = data.get("split", {"train": 0.7, "val": 0.15, "test": 0.15})
        epochs = data.get("epochs", 10)
        model_name = data.get("model_name", f"model-{training_job_id[:8]}")
        class_names = sorted(dataset.keys())

        log.info("[%s] Downloading %d classes...", training_job_id, len(class_names))
        paths_by_class = _download_dataset(dataset, tmp_dir)

        splits = _stratified_split(
            paths_by_class, split_cfg["train"], split_cfg["val"], split_cfg["test"]
        )
        _materialize_split_dirs(splits, tmp_dir)

        train_ds = tf.keras.utils.image_dataset_from_directory(
            tmp_dir / "train", image_size=IMG_SIZE, batch_size=BATCH_SIZE, label_mode="int"
        )
        val_ds = tf.keras.utils.image_dataset_from_directory(
            tmp_dir / "val", image_size=IMG_SIZE, batch_size=BATCH_SIZE, label_mode="int"
        )
        test_ds = tf.keras.utils.image_dataset_from_directory(
            tmp_dir / "test",
            image_size=IMG_SIZE,
            batch_size=BATCH_SIZE,
            label_mode="int",
            shuffle=False,
        )
        # `image_dataset_from_directory` assigns class indices alphabetically —
        # keep our class_names list in that same order for label alignment.
        class_names = train_ds.class_names

        model = _build_model(num_classes=len(class_names))

        log.info("[%s] Training for %d epochs...", training_job_id, epochs)
        model.fit(train_ds, validation_data=val_ds, epochs=epochs, verbose=2)

        # ── Real test-set evaluation (the thing Teachable Machine can't do) ──
        y_true, y_pred = [], []
        for images, labels in test_ds:
            preds = model.predict(images, verbose=0)
            y_true.extend(labels.numpy().tolist())
            y_pred.extend(np.argmax(preds, axis=1).tolist())

        accuracy = float(np.mean(np.array(y_true) == np.array(y_pred))) if y_true else 0.0
        precision, recall, f1, support = precision_recall_fscore_support(
            y_true, y_pred, labels=list(range(len(class_names))), zero_division=0
        )
        cm = confusion_matrix(y_true, y_pred, labels=list(range(len(class_names)))).tolist()

        per_class_metrics = {
            class_names[i]: {
                "precision": float(precision[i]),
                "recall": float(recall[i]),
                "f1": float(f1[i]),
                "support": int(support[i]),
            }
            for i in range(len(class_names))
        }

        # Save + upload the model
        model_path = tmp_dir / "keras_model.h5"
        model.save(model_path)
        model_id = str(uuid.uuid4())
        upload_result = cloudinary_service.upload_raw_file(
            str(model_path), public_id=f"models/{model_id}/keras_model"
        )

        metrics = {
            "accuracy": accuracy,
            "per_class": per_class_metrics,
            "confusion_matrix": cm,
            "test_set_size": len(y_true),
        }

        db.collection("models").document(model_id).set(
            {
                "model_id": model_id,
                "name": model_name,
                "labels": class_names,
                "cloudinary_url": upload_result["secure_url"],
                "cloudinary_public_id": upload_result["public_id"],
                "metrics": metrics,
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
                "metrics": metrics,
            }
        )
        log.info("[%s] Training complete. Test accuracy: %.3f", training_job_id, accuracy)

    except Exception as e:
        log.exception("[%s] Training failed", training_job_id)
        job_ref.update({"status": "failed", "completed_at": _now_iso(), "error": str(e)})

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
