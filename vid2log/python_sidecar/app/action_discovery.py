"""
"Create actions" — auto-discovers candidate action classes from a raw demo
video, so a model can be trained from one screen recording instead of
hand-curating example images per action. The offline-desktop port of
backend/app/services/action_discovery_pipeline.py (itself a port of
Vid2Log_AutoDiscover_Classes.ipynb).

Pipeline: Video -> Frame Sampling -> Embeddings -> HDBSCAN Clustering ->
Noise Reassignment -> Per-Cluster Diversity Sampling -> Preview Frames.

Two deliberate departures from the cloud version, both about keeping this
genuinely offline and dependency-light:

  * EMBEDDINGS use MobileNetV2 (ImageNet, global-average-pooled, 1280-d)
    rather than DINOv2. DINOv2 would mean a ~2.5GB torch + transformers
    install AND a first-run download of its weights from HuggingFace —
    which would break the "works with no network at all" promise the whole
    sidecar is built around. MobileNetV2 comes from TensorFlow, which is
    already a dependency, and its ImageNet weights are already on this
    machine because app/training_pipeline.py uses the same backbone. DINOv2's
    self-supervised features are the better general-purpose embedding, but
    distinct UI screens are mostly distinguishable by layout and colour, and
    the human review step downstream exists precisely to fix whatever the
    clustering gets wrong. If cluster quality ever proves insufficient on
    real videos, swapping `_embed_frames` for a DINOv2 implementation is a
    self-contained change — nothing else in this module depends on which
    backbone produced the vectors.

  * CLUSTERING uses scikit-learn's built-in HDBSCAN rather than the separate
    `hdbscan` package. Same algorithm, and scikit-learn is already installed
    — whereas `hdbscan` needs a C compiler to build (which is exactly what
    broke the cloud backend's Docker build until build-essential was added).

Storage mirrors the cloud version's temp-vs-permanent split, just on local
disk instead of Cloud Storage (see app/config.py):

    the user's own video (never copied or modified)
      -> sampled, embedded, clustered (this module)
      -> preview frames written to DISCOVERY_TEMP_DIR/{job_id}/{cluster}/
         (still temporary — nobody's reviewed anything yet)
      -> person reviews in the Flutter app: rename / merge / drop actions
      -> POST /actions/discover/{id}/save copies exactly the KEPT frames
         into ACTION_DATASETS_DIR/{dataset_id}/{action}/ and deletes the
         temp folder

Diversity sampling runs TWICE, as in the cloud version: once per raw cluster
here (so review never shows hundreds of near-identical thumbnails for one
long static screen), and again at save time on the final, possibly-merged
pool per surviving action (bounding the saved dataset at ~25 images/action).

TensorFlow is imported LAZILY inside run_discovery_job, same as
app/training_pipeline.py — a broken install must surface as one visible,
retryable "failed" job rather than an import-time crash.
"""
from __future__ import annotations

import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

import cv2
import numpy as np

from app.config import DISCOVERY_TEMP_DIR
from app.db import get_discovery_job, update_discovery_job

log = logging.getLogger(__name__)

# Bounds how many preview images get written PER RAW CLUSTER — not the final
# per-action cap (applied again at save time; see the module docstring).
# Matches the Train screen's own "~20-25 example images per action" guidance.
MAX_PREVIEW_IMAGES_PER_CLUSTER = 25

# MobileNetV2's expected input size — the same 224x224 the rest of the app
# standardises on (app/ml/preprocessing.py, app/training_pipeline.py).
EMBED_SIZE = (224, 224)

# Frames are embedded in batches rather than one at a time: a single
# forward pass over 32 frames is dramatically faster than 32 passes, and
# 32x224x224x3 floats is only ~19MB, which is safe on any machine that can
# already run training.
EMBED_BATCH_SIZE = 32


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _progress(discovery_job_id: str, **payload) -> None:
    """Progress ping for the Create actions screen. Errors swallowed — a
    failed "stage" write must never take down a healthy discovery run."""
    try:
        update_discovery_job(discovery_job_id, {"progress": payload})
    except Exception:
        log.warning("[%s] Progress update %s failed — discovery continues.", discovery_job_id, payload)


def _sample_frames(video_path: Path, desired_fps: int) -> Tuple[List[np.ndarray], List[float]]:
    """Keeps frames at a fixed rate rather than every raw frame — consecutive
    frames in a screen recording are almost always near-identical. Direct
    port of the notebook's sample_frames()."""
    video = cv2.VideoCapture(str(video_path))
    if not video.isOpened():
        raise IOError(f"Could not open video: {video_path}")

    src_fps = video.get(cv2.CAP_PROP_FPS) or 30.0
    interval = max(1, int(round(src_fps / desired_fps)))

    frames: List[np.ndarray] = []
    timestamps: List[float] = []
    count = 0
    while True:
        ret, frame = video.read()
        if not ret:
            break
        if count % interval == 0:
            frames.append(frame)  # BGR, as read by OpenCV
            timestamps.append(count / src_fps)
        count += 1

    video.release()
    return frames, timestamps


def _embed_frames(frames: List[np.ndarray]) -> np.ndarray:
    """MobileNetV2 global-average-pooled features, one 1280-d vector per
    frame. See the module docstring for why this backbone rather than
    DINOv2, and note that swapping it out only requires this function to
    keep returning one vector per input frame, in order."""
    backbone = tf.keras.applications.MobileNetV2(
        input_shape=(*EMBED_SIZE, 3), include_top=False, weights="imagenet", pooling="avg"
    )

    vectors: List[np.ndarray] = []
    for start in range(0, len(frames), EMBED_BATCH_SIZE):
        batch = frames[start : start + EMBED_BATCH_SIZE]
        prepared = []
        for frame_bgr in batch:
            rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            # Plain resize (not the letterboxed resize_with_padding the
            # classifier uses) is fine here: these vectors are only ever
            # compared against each OTHER for clustering, never fed to a
            # model trained on letterboxed images, and every frame from one
            # video shares an aspect ratio anyway — so whatever distortion
            # the resize introduces is identical across all of them and
            # cancels out of the distances.
            resized = cv2.resize(rgb, EMBED_SIZE, interpolation=cv2.INTER_AREA)
            prepared.append((resized.astype(np.float32) / 127.5) - 1.0)
        arr = np.stack(prepared, axis=0)
        vectors.append(np.asarray(backbone(arr, training=False)))

    return np.concatenate(vectors, axis=0)


def _reassign_noise(embeddings: np.ndarray, labels: np.ndarray) -> np.ndarray:
    """HDBSCAN leaves ambiguous frames unlabeled (-1) rather than forcing
    them into a cluster it isn't confident about. Every sampled frame here
    is a real moment from the person's demo and should land in SOME action,
    so each noise frame is folded into whichever real cluster's centroid it
    is closest to. Direct port of the notebook's reassign_noise()."""
    labels = labels.copy()
    real_clusters = sorted(set(labels.tolist()) - {-1})
    if not real_clusters:
        return labels
    centroids = np.stack([embeddings[labels == c].mean(axis=0) for c in real_clusters])
    noise_idx = np.where(labels == -1)[0]
    for i in noise_idx:
        dists = np.linalg.norm(centroids - embeddings[i], axis=1)
        labels[i] = real_clusters[int(np.argmin(dists))]
    return labels


def _build_cluster_summaries(embeddings: np.ndarray, labels: np.ndarray) -> Dict[int, dict]:
    """Per cluster: its members and its medoid (the member closest to the
    centroid, i.e. the most representative frame). Direct port of the
    notebook's build_cluster_summaries(). No auto-naming — clusters are
    plain "Action N" and the review UI is where a person names them, which
    is a five-second edit and avoids loading a whole captioning model to
    propose names nobody would keep unedited."""
    clusters: Dict[int, dict] = {}
    for cluster_id in sorted(set(labels.tolist())):
        member_idx = np.where(labels == cluster_id)[0]
        centroid = embeddings[member_idx].mean(axis=0)
        dists = np.linalg.norm(embeddings[member_idx] - centroid, axis=1)
        medoid_idx = int(member_idx[np.argmin(dists)])
        clusters[int(cluster_id)] = {
            "id": int(cluster_id),
            "member_indices": member_idx.tolist(),
            "medoid_index": medoid_idx,
        }
    return clusters


def farthest_point_sample(indices: List[int], embeddings: np.ndarray, k: int) -> List[int]:
    """Greedy k-center diversity sampling, so kept images are spread through
    embedding space rather than dozens of near-duplicates of one long static
    screen. Public (not `_`-prefixed) because the save handler in
    app/main.py re-runs it on the final merged pool per action — see the
    module docstring's "twice" note."""
    indices = list(indices)
    if len(indices) <= k:
        return indices
    chosen = [indices[0]]
    remaining = set(indices[1:])
    while len(chosen) < k and remaining:
        chosen_embs = embeddings[chosen]
        best_idx, best_dist = None, -1.0
        for idx in remaining:
            d = float(np.linalg.norm(chosen_embs - embeddings[idx], axis=1).min())
            if d > best_dist:
                best_dist, best_idx = d, idx
        chosen.append(best_idx)
        remaining.discard(best_idx)
    return chosen


def run_discovery_job(discovery_job_id: str) -> None:
    """Entry point run on video_pipeline.JOB_EXECUTOR (see
    submit_discovery_job). Everything that can fail is inside the try, so a
    failure lands as a visible, retryable "failed" status rather than a
    silently stuck "queued" one."""
    job = get_discovery_job(discovery_job_id)
    if job is None:
        log.error("Discovery job %s not found in the local database.", discovery_job_id)
        return

    temp_dir = DISCOVERY_TEMP_DIR / discovery_job_id

    try:
        update_discovery_job(
            discovery_job_id,
            {
                "status": "processing",
                "started_at": _now_iso(),
                "completed_at": None,
                "error": None,
                "progress": {"stage": "starting"},
            },
        )

        # Lazy import — see the module docstring. `global tf` publishes it so
        # _embed_frames (resolved at call time, not definition time) sees it.
        global tf
        import tensorflow as tf
        from sklearn.cluster import HDBSCAN
        from sklearn.preprocessing import normalize

        video_path = Path(job["video_path"])
        if not video_path.exists():
            raise FileNotFoundError(f"Video file not found: {video_path}")

        fps = job["fps"]
        min_cluster_size = job["min_cluster_size"]

        _progress(discovery_job_id, stage="sampling", detail="Sampling frames")
        frames, _timestamps = _sample_frames(video_path, desired_fps=fps)
        log.info("[%s] Sampled %d frames.", discovery_job_id, len(frames))
        if len(frames) < min_cluster_size:
            raise ValueError(
                f"Only {len(frames)} frame(s) were sampled from this video — too few to cluster "
                f"(need at least {min_cluster_size}, the min cluster size setting). Try a longer "
                "video, a higher sampling fps, or a smaller min cluster size."
            )

        _progress(
            discovery_job_id,
            stage="embedding",
            detail=f"Embedding {len(frames)} frames",
            total=len(frames),
        )
        embeddings = _embed_frames(frames)
        log.info("[%s] Computed %d embeddings (dim=%d).", discovery_job_id, *embeddings.shape)

        _progress(discovery_job_id, stage="clustering", detail="Clustering frames")
        normed = normalize(embeddings, norm="l2")
        labels = HDBSCAN(min_cluster_size=min_cluster_size, metric="euclidean").fit_predict(normed)
        final_labels = _reassign_noise(normed, labels)

        cluster_summaries = _build_cluster_summaries(normed, final_labels)
        if not cluster_summaries:
            raise ValueError(
                "No recurring screens/actions were found in this video — try a lower min cluster "
                "size, or a video with more distinct, held screens."
            )
        log.info("[%s] Found %d clusters.", discovery_job_id, len(cluster_summaries))

        _progress(
            discovery_job_id,
            stage="writing_previews",
            detail=f"Preparing previews for {len(cluster_summaries)} actions",
        )
        # A retried run must not inherit the previous attempt's frames.
        shutil.rmtree(temp_dir, ignore_errors=True)

        clusters_out = []
        for i, (cluster_id, cluster) in enumerate(sorted(cluster_summaries.items())):
            picked = farthest_point_sample(
                cluster["member_indices"], normed, MAX_PREVIEW_IMAGES_PER_CLUSTER
            )
            cluster_dir = temp_dir / str(cluster_id)
            cluster_dir.mkdir(parents=True, exist_ok=True)

            written = 0
            for frame_pos, frame_idx in enumerate(picked):
                ok, buf = cv2.imencode(".jpg", frames[frame_idx])
                if not ok:
                    continue
                (cluster_dir / f"{frame_pos}.jpg").write_bytes(buf.tobytes())
                written += 1

            clusters_out.append(
                {"id": str(cluster_id), "name": f"Action {i + 1}", "frame_count": written}
            )

        update_discovery_job(
            discovery_job_id,
            {
                "status": "done",
                "completed_at": _now_iso(),
                "clusters": clusters_out,
                "progress": None,
            },
        )
        log.info(
            "[%s] Discovery complete — %d candidate actions proposed.",
            discovery_job_id,
            len(clusters_out),
        )

    except Exception as e:
        log.exception("[%s] Action discovery failed", discovery_job_id)
        update_discovery_job(
            discovery_job_id,
            {"status": "failed", "completed_at": _now_iso(), "error": str(e)[:2000], "progress": None},
        )
