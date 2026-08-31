"""
"Create actions" — auto-discovers unique training classes from a raw demo
video, so a model can be trained from a single screen recording instead of
manually curating example images per class by hand. Ported from
Vid2Log_AutoDiscover_Classes.ipynb (see that notebook for the original,
interactive, Colab version this is based on).

Pipeline: Video -> Frame Sampling -> DINOv2 Embeddings -> HDBSCAN Clustering
-> Noise Reassignment -> Per-Cluster Diversity Sampling -> Preview Upload.
Deliberately does NOT include the notebook's two most experimental/heaviest
steps:
  - No BLIP (or any) auto-naming model. Clusters are just named "Action 1",
    "Action 2", ... in cluster order — the frontend's review UI is where a
    person renames them to something meaningful, which is a five-second
    edit per class and avoids loading a whole second vision-language model
    just to propose names nobody would keep unedited anyway.
  - No OCR/region-diff cluster refinement (the "_with_ClusterRefinement"
    notebook variant) — that step computed a result it never actually used
    downstream and added a heavy PaddleOCR dependency for it; see the
    conversation that led to this file for the full analysis. If cluster
    purity ever becomes a real, observed problem, the fix belongs here as a
    finer HDBSCAN re-clustering per cluster (reusing embeddings already
    computed below), not a second heavy captioning/OCR stack.

TEMPORARY vs PERMANENT storage (this is the one thing that's genuinely new
in this pipeline compared to every other job in this codebase, so it's
called out explicitly):

    Cloud Storage (video, temporary — same as video_pipeline.py)
        --> downloaded, sampled, embedded, clustered (this module)
        --> each cluster's diversity-sampled preview frames written to
            ACTION_DISCOVERY_TEMP_PREFIX (STILL temporary — nothing here is
            durable yet, since the person hasn't reviewed/renamed/merged
            anything)
        --> person reviews in the frontend, renames/merges/adds/deletes
            classes (routers/actions.py serves each preview frame on
            demand, proxied through our own credentialed client — never a
            public URL)
        --> POST /actions/discover/{id}/save copies exactly the KEPT frames
            into ACTION_DATASET_PREFIX (genuinely PERMANENT now — kept
            until the user deletes that dataset) and deletes the whole
            temp prefix

Diversity sampling happens TWICE, not once like the notebook: once per
raw HDBSCAN cluster here (bounding how many preview images ever get
uploaded/shown for review — a long static screen can have hundreds of
near-duplicate member frames, and nobody needs to review hundreds of
thumbnails for one class), and again in routers/actions.py's save handler
on the final, possibly-merged pool of frames per surviving class (bounding
the PERMANENT dataset at ~25 images/class, matching the Train page's own
"~20-25 example images per class" guidance). The notebook only samples once
at export time because it has no separate "preview" step. Splitting it into
two passes here does not change the goal (a small, diverse example set per
final class) — it just keeps the human-review step itself fast and cheap.

IMPORTANT — same reasoning as training_pipeline.py's `import tensorflow`
(see that module's docstring for the full story): torch/transformers/
hdbscan/sklearn are imported LAZILY, INSIDE run_discovery_job()'s try block,
not at module level. RQ resolves this module's entry point by importing the
whole module the instant a job referencing it is dequeued — a broken local
torch/transformers/hdbscan install must surface as one visible, retryable
"failed" job with a real error message, not a silent worker crash with
nothing ever written back to Firestore.
"""
from __future__ import annotations

import logging
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

import cv2
import numpy as np
from google.api_core.retry import Retry
from PIL import Image

from app.services import gcs_service
from app.services.firebase_service import get_db

log = logging.getLogger(__name__)

# See training_pipeline.py's FIRESTORE_TIMEOUT_S/_FAST_RETRY comment for why
# both the per-attempt `timeout=` AND the `retry=` policy override are
# needed — one alone (just `timeout=`) does not bound the total retry loop.
FIRESTORE_TIMEOUT_S = 15.0
_FAST_RETRY = Retry(initial=1.0, maximum=4.0, multiplier=2.0, timeout=FIRESTORE_TIMEOUT_S)

DINO_MODEL_ID = "facebook/dinov2-base"

# Bounds how many preview images get uploaded/shown for review PER RAW
# CLUSTER — not the final per-class cap (that's applied again, separately,
# at save time in routers/actions.py; see the module docstring above).
# Matches the Train page's own "~20-25 example images per class" guidance.
MAX_PREVIEW_IMAGES_PER_CLUSTER = 25


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _update_job(job_ref, **fields) -> None:
    """Best-effort Firestore update for PROGRESS reporting only — mirrors
    training_pipeline.py's _update_job(): swallows its own errors so a
    transient network hiccup while pinging a stage update doesn't take down
    an otherwise-healthy discovery run. The final status="done"/"failed"
    writes deliberately do NOT go through this helper."""
    try:
        job_ref.update(fields, retry=_FAST_RETRY, timeout=FIRESTORE_TIMEOUT_S)
    except Exception:
        log.warning("[%s] Progress update %s failed (transient?) — discovery continues.", job_ref.id, fields)


def _sample_and_embed(
    video_path: Path, desired_fps: int, embed_fn
) -> Tuple[List[bytes], np.ndarray, List[float]]:
    """Samples frames at a fixed rate AND embeds each one immediately,
    discarding the raw decoded frame right after — replaces what used to be
    two separate passes (sample all frames into memory, then embed all of
    them). Holding every sampled frame as a raw, uncompressed BGR array
    (several MB each, for a whole video's worth of frames) simultaneously is
    what OOM-kills this job on longer videos; peak memory here no longer
    scales with video length, only with the number of embeddings (~3KB each)
    and JPEG-encoded preview bytes (a few hundred KB each) kept per frame —
    both needed later (embeddings for clustering, JPEGs for the preview
    upload step), unlike the raw frame itself.

    Returns (frame_jpegs, embeddings, timestamps) — frame_jpegs are
    pre-encoded so the preview-upload step just writes bytes, no re-encoding
    from a raw frame it no longer has.
    """
    video = cv2.VideoCapture(str(video_path))
    if not video.isOpened():
        raise IOError(f"Could not open video: {video_path}")

    src_fps = video.get(cv2.CAP_PROP_FPS) or 30.0
    interval = max(1, int(round(src_fps / desired_fps)))

    frame_jpegs: List[bytes] = []
    embeddings: List[np.ndarray] = []
    timestamps: List[float] = []
    count = 0
    while True:
        ret, frame = video.read()
        if not ret:
            break
        if count % interval == 0:
            embeddings.append(embed_fn(frame))
            ok, buf = cv2.imencode(".jpg", frame)
            frame_jpegs.append(buf.tobytes() if ok else b"")
            timestamps.append(count / src_fps)
        count += 1

    video.release()
    return frame_jpegs, np.stack(embeddings) if embeddings else np.empty((0, 0)), timestamps


def _reassign_noise(embeddings: np.ndarray, labels: np.ndarray) -> np.ndarray:
    """Direct port of the notebook's reassign_noise() — HDBSCAN leaves
    ambiguous frames unlabeled (-1) rather than forcing them into a cluster
    it isn't confident about; every sampled frame here is a real moment
    from the person's demo and should end up in SOME class, so each noise
    frame gets folded into whichever real cluster's centroid it's closest
    to."""
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
    """Direct port of the notebook's build_cluster_summaries() — finds each
    cluster's medoid (the member frame closest to the cluster's centroid),
    used as the representative for the export order below. Unlike the
    notebook, no placeholder/auto-generated name is set here — that's done
    entirely in run_discovery_job(), as plain "Action N" labels."""
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
    """Direct port of the notebook's farthest_point_sample() — greedy
    k-center diversity sampling, so the images kept are spread out in
    embedding space rather than dozens of near-duplicates of a long static
    screen. Exported (not prefixed `_`) since routers/actions.py's save
    handler re-runs this same function on the final, possibly-merged pool
    of frames per surviving class — see the module docstring's "diversity
    sampling happens TWICE" section."""
    indices = list(indices)
    if len(indices) <= k:
        return indices
    chosen = [indices[0]]
    remaining = set(indices[1:])
    while len(chosen) < k and remaining:
        chosen_embs = embeddings[chosen]
        best_idx, best_dist = None, -1.0
        for idx in remaining:
            d = np.linalg.norm(chosen_embs - embeddings[idx], axis=1).min()
            if d > best_dist:
                best_dist, best_idx = d, idx
        chosen.append(best_idx)
        remaining.discard(best_idx)
    return chosen


def run_discovery_job(job_id: str) -> None:
    """Entry point called by the RQ worker for `action_discovery` jobs.

    Same hardening as video_pipeline.py/training_pipeline.py: every
    Firestore/network call, including the very first job_ref.get(), lives
    INSIDE the try block with a short-deadline retry= override, so a
    transient outage surfaces as a normal, visible, retryable "failed" job
    within seconds instead of leaving the doc stuck at "queued" forever."""
    db = get_db()
    job_ref = db.collection("action_discovery_jobs").document(job_id)
    tmp_dir = Path(tempfile.mkdtemp(prefix=f"vid2log_actions_{job_id}_"))

    try:
        job = job_ref.get(retry=_FAST_RETRY, timeout=FIRESTORE_TIMEOUT_S)
        if not job.exists:
            log.error("Action discovery job %s not found in Firestore.", job_id)
            return
        data = job.to_dict()

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

        # See the module docstring — MUST stay inside this try block, not
        # hoisted to module level. `global` publishes these names so the
        # nested _embed() closure below (and anything else in this
        # function) can resolve them normally.
        global torch, AutoImageProcessor, AutoModel, hdbscan, normalize
        import torch
        from transformers import AutoImageProcessor, AutoModel
        import hdbscan
        from sklearn.preprocessing import normalize

        owner_uid = data["owner_uid"]
        storage_path = data["storage_path"]
        fps = data.get("fps", 2)
        min_cluster_size = data.get("min_cluster_size", 5)

        video_path = tmp_dir / "video"
        log.info("[%s] Downloading video from Cloud Storage...", job_id)
        gcs_service.download_blob(storage_path, video_path)

        device = "cuda" if torch.cuda.is_available() else "cpu"
        _update_job(
            job_ref,
            progress={"stage": "sampling", "detail": f"Sampling and embedding frames (DINOv2, {device})"},
        )
        processor = AutoImageProcessor.from_pretrained(DINO_MODEL_ID)
        dino_model = AutoModel.from_pretrained(DINO_MODEL_ID).to(device)
        dino_model.eval()

        @torch.no_grad()
        def _embed(frame_bgr):
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
            pil_img = Image.fromarray(frame_rgb)
            inputs = processor(images=pil_img, return_tensors="pt").to(device)
            outputs = dino_model(**inputs)
            # CLS token: a single 768-d vector summarizing the whole frame.
            return outputs.last_hidden_state[:, 0, :].squeeze(0).cpu().numpy()

        # See _sample_and_embed's docstring — sampling and embedding happen
        # in one pass now, specifically so a long/high-resolution video's
        # raw decoded frames are never all resident in memory at once.
        frame_jpegs, embeddings, _timestamps = _sample_and_embed(video_path, desired_fps=fps, embed_fn=_embed)
        log.info("[%s] Sampled and embedded %d frames.", job_id, len(frame_jpegs))
        if len(frame_jpegs) < min_cluster_size:
            raise ValueError(
                f"Only {len(frame_jpegs)} frame(s) were sampled from this video — too few to cluster "
                f"(need at least {min_cluster_size}, the min cluster size setting). Try a longer "
                "video, a higher sampling fps, or a smaller min cluster size."
            )
        log.info("[%s] Computed %d embeddings (dim=%d).", job_id, embeddings.shape[0], embeddings.shape[1])

        _update_job(job_ref, progress={"stage": "clustering", "detail": "Clustering (HDBSCAN)"})
        normed_embeddings = normalize(embeddings, norm="l2")
        clusterer = hdbscan.HDBSCAN(min_cluster_size=min_cluster_size, metric="euclidean")
        raw_labels = clusterer.fit_predict(normed_embeddings)
        final_labels = _reassign_noise(normed_embeddings, raw_labels)

        cluster_summaries = _build_cluster_summaries(normed_embeddings, final_labels)
        if not cluster_summaries:
            raise ValueError(
                "No recurring screens/actions were found in this video — try a lower min cluster "
                "size, or a video with more distinct, held screens."
            )
        log.info("[%s] Found %d clusters.", job_id, len(cluster_summaries))

        _update_job(
            job_ref,
            progress={
                "stage": "uploading_previews",
                "detail": f"Uploading preview images for {len(cluster_summaries)} classes",
            },
        )
        clusters_out = []
        for i, (cluster_id, cluster) in enumerate(sorted(cluster_summaries.items())):
            picked = farthest_point_sample(
                cluster["member_indices"], normed_embeddings, MAX_PREVIEW_IMAGES_PER_CLUSTER
            )
            uploaded = 0
            for frame_pos, frame_idx in enumerate(picked):
                # Already JPEG-encoded by _sample_and_embed — no raw frame
                # to re-encode from anymore (that's the whole point).
                jpeg_bytes = frame_jpegs[frame_idx]
                if not jpeg_bytes:
                    continue
                blob_path = (
                    f"{gcs_service.ACTION_DISCOVERY_TEMP_PREFIX}{owner_uid}/{job_id}/{cluster_id}/{frame_pos}.jpg"
                )
                gcs_service.upload_bytes(jpeg_bytes, blob_path)
                uploaded += 1
            clusters_out.append({"id": str(cluster_id), "name": f"Action {i + 1}", "frame_count": uploaded})

        job_ref.update(
            {"status": "done", "completed_at": _now_iso(), "clusters": clusters_out, "progress": None},
            retry=_FAST_RETRY,
            timeout=FIRESTORE_TIMEOUT_S,
        )
        log.info("[%s] Discovery complete — %d candidate classes proposed.", job_id, len(clusters_out))

        # Only delete the source video once its frames are safely uploaded
        # as previews — same "temporary" policy as video_pipeline.py's own
        # job (see that module's docstring).
        gcs_service.delete_blob(storage_path)

    except Exception as e:
        log.exception("[%s] Action discovery failed", job_id)
        try:
            job_ref.update(
                {"status": "failed", "completed_at": _now_iso(), "error": str(e)[:2000], "progress": None},
                retry=_FAST_RETRY,
                timeout=FIRESTORE_TIMEOUT_S,
            )
        except Exception:
            log.error(
                "[%s] Also failed to write the 'failed' status to Firestore — "
                "leaving this to RQ's automatic retry (see queue_service.py).",
                job_id,
            )
            raise

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
