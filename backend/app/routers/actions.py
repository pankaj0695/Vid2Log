"""
"Create actions" — auto-discover training classes from a demo video, review
them (rename/merge/add/delete), and save the result as a reusable, PERMANENT
image dataset. See app/services/action_discovery_pipeline.py for the actual
DINOv2 + HDBSCAN pipeline and the full temp-vs-permanent storage story.

Two Firestore collections, deliberately kept separate (same split as
`jobs` vs `models`, or `training_jobs` vs `models`):
  - `action_discovery_jobs` — EPHEMERAL. One per video processed through
    discovery; deleted once its owner either saves it (POST .../save) or
    explicitly deletes it (DELETE .../discover/{id}).
  - `action_datasets` — PERMANENT. One per saved dataset; lives until the
    owner explicitly deletes it (DELETE .../datasets/{id}). This is the
    thing "Create actions" is actually for — everything else here is just
    the road to producing one of these.

Every image-serving endpoint below proxies bytes through our own
service-account-credentialed Cloud Storage client rather than ever handing
out a public/signed-read URL — same "nothing is ever publicly fetchable"
policy as the rest of this app (see gcs_service.py's module docstring).
"""
import logging
import uuid
from datetime import datetime, timezone
from typing import Dict, List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from app.schemas import (
    ActionDatasetClassOut,
    ActionDatasetOut,
    ActionDiscoverRequest,
    ActionDiscoveryJobOut,
    ActionProgress,
    CopyForTrainingRequest,
    DiscoveredCluster,
    SaveActionDatasetRequest,
    TrainingImageRef,
    UpdateActionDatasetRequest,
)
from app.services import gcs_service
from app.services.firebase_service import get_current_user, get_db
from app.services.queue_service import enqueue_action_discovery_job

log = logging.getLogger(__name__)
router = APIRouter(prefix="/actions", tags=["actions"])


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _check_owner(data: dict, user: dict) -> None:
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not yours")


def _to_job_out(data: dict) -> ActionDiscoveryJobOut:
    progress = data.get("progress")
    clusters = data.get("clusters")
    return ActionDiscoveryJobOut(
        job_id=data["job_id"],
        status=data["status"],
        original_filename=data["original_filename"],
        fps=data.get("fps", 2),
        error=data.get("error"),
        progress=ActionProgress(**progress) if progress else None,
        clusters=[DiscoveredCluster(**c) for c in clusters] if clusters is not None else None,
        created_at=data.get("created_at"),
        started_at=data.get("started_at"),
        completed_at=data.get("completed_at"),
    )


def _to_dataset_out(data: dict) -> ActionDatasetOut:
    return ActionDatasetOut(
        dataset_id=data["dataset_id"],
        name=data["name"],
        source_video_filename=data.get("source_video_filename"),
        classes=[ActionDatasetClassOut(**c) for c in data.get("classes", [])],
        total_images=data.get("total_images", 0),
        created_at=data.get("created_at"),
    )


# ── Discovery jobs ───────────────────────────────────────────────────────

@router.post("/discover", response_model=ActionDiscoveryJobOut)
def start_discovery(payload: ActionDiscoverRequest, user: dict = Depends(get_current_user)):
    """Register a video that's already been uploaded directly to Cloud
    Storage (via POST /uploads/signed-url, kind="video" — identical flow to
    Process video) and enqueue it for class discovery."""
    db = get_db()
    job_id = str(uuid.uuid4())

    doc = {
        "job_id": job_id,
        "status": "queued",
        "owner_uid": user["uid"],
        "original_filename": payload.original_filename,
        "storage_path": payload.storage_path,
        "fps": payload.fps,
        "min_cluster_size": payload.min_cluster_size,
        "created_at": _now_iso(),
    }
    db.collection("action_discovery_jobs").document(job_id).set(doc)
    enqueue_action_discovery_job(job_id)

    return ActionDiscoveryJobOut(job_id=job_id, status="queued", original_filename=payload.original_filename, fps=payload.fps)


@router.get("/discover", response_model=List[ActionDiscoveryJobOut])
def list_discovery_jobs(limit: int = 20, user: dict = Depends(get_current_user)):
    """See jobs.py::list_jobs for why owner filtering + sort/limit happens
    in Python rather than a Firestore composite query."""
    db = get_db()
    docs = [d.to_dict() for d in db.collection("action_discovery_jobs").where("owner_uid", "==", user["uid"]).stream()]
    docs.sort(key=lambda d: d.get("created_at") or "", reverse=True)
    return [_to_job_out(d) for d in docs[:limit]]


@router.get("/discover/{job_id}", response_model=ActionDiscoveryJobOut)
def get_discovery_job(job_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    doc = db.collection("action_discovery_jobs").document(job_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Discovery job not found")
    data = doc.to_dict()
    _check_owner(data, user)
    return _to_job_out(data)


@router.get("/discover/{job_id}/frames/{cluster_id}/{frame_id}")
def get_discovery_frame(job_id: str, cluster_id: str, frame_id: str, user: dict = Depends(get_current_user)):
    """Streams one preview frame's JPEG bytes for the review grid. `job_id`
    is ownership-checked against Firestore; `cluster_id`/`frame_id` are just
    the last two segments of a blob path scoped under this job's own
    uid/job_id prefix — a bogus value here can only ever 404 against this
    same user's own temp folder, never reach another user's or job's data
    (see the module docstring)."""
    db = get_db()
    doc = db.collection("action_discovery_jobs").document(job_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Discovery job not found")
    data = doc.to_dict()
    _check_owner(data, user)

    blob_path = f"{gcs_service.ACTION_DISCOVERY_TEMP_PREFIX}{user['uid']}/{job_id}/{cluster_id}/{frame_id}.jpg"
    try:
        image_bytes = gcs_service.download_bytes(blob_path)
    except Exception:
        raise HTTPException(status_code=404, detail="Preview frame not found (it may already have been saved away).")
    return Response(content=image_bytes, media_type="image/jpeg")


@router.delete("/discover/{job_id}")
def cancel_or_delete_discovery_job(job_id: str, user: dict = Depends(get_current_user)):
    """Same dual-purpose semantics as DELETE /jobs/{id} — cancel a queued
    job, or genuinely remove a done/failed one (including its temp preview
    frames, if any were already uploaded)."""
    db = get_db()
    ref = db.collection("action_discovery_jobs").document(job_id)
    doc = ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Discovery job not found")
    data = doc.to_dict()
    _check_owner(data, user)

    status = data.get("status")
    if status == "queued":
        ref.update({"status": "cancelled"})
        return {"status": "cancelled"}
    if status == "processing":
        return {"status": status, "note": "Already picked up by a worker; cannot cancel."}

    gcs_service.delete_blobs_with_prefix(f"{gcs_service.ACTION_DISCOVERY_TEMP_PREFIX}{user['uid']}/{job_id}/")
    if status == "failed" and data.get("storage_path"):
        try:
            gcs_service.delete_blob(data["storage_path"])
        except Exception:
            log.warning("Failed to delete leftover video blob for discovery job %s", job_id, exc_info=True)

    ref.delete()
    return {"status": "deleted"}


@router.post("/discover/{job_id}/save", response_model=ActionDatasetOut)
def save_action_dataset(job_id: str, payload: SaveActionDatasetRequest, user: dict = Depends(get_current_user)):
    """Turns the frontend's final reviewed state (whatever renames/merges/
    adds/deletes happened client-side) into a PERMANENT action_datasets doc.
    Nothing is written to permanent storage until this succeeds. Every kept
    image gets a server-side Cloud Storage COPY (no bytes round-trip our own
    server) into action-datasets/{dataset_id}/{class_index}/{image_index}.jpg
    — deliberately indexed by position, not by class name, so a later rename
    never has to move blobs. The whole discovery job (its temp preview
    frames AND its Firestore doc) is torn down afterward regardless of which
    images were actually kept — its only purpose was staging for this
    moment."""
    db = get_db()
    job_ref = db.collection("action_discovery_jobs").document(job_id)
    job_doc = job_ref.get()
    if not job_doc.exists:
        raise HTTPException(status_code=404, detail="Discovery job not found")
    job_data = job_doc.to_dict()
    _check_owner(job_data, user)
    if job_data.get("status") != "done":
        raise HTTPException(
            status_code=409, detail=f"Discovery job is '{job_data.get('status')}', not ready to save yet."
        )

    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give this dataset a name.")
    usable_classes = [c for c in payload.classes if c.name.strip() and c.images]
    if len(usable_classes) < 1:
        raise HTTPException(status_code=400, detail="Add at least one class with at least one image.")

    # Manually-added images arrive as a training-image signed upload
    # (POST /uploads/signed-url, kind="training-image") — scoped exactly
    # like every other use of that kind, uid-prefixed, so this refuses to
    # copy anything outside the caller's own upload area.
    training_upload_prefix = f"training-uploads/{user['uid']}/"

    dataset_id = str(uuid.uuid4())
    classes_out: List[dict] = []
    total_images = 0
    consumed_training_uploads: List[str] = []

    for class_index, cls in enumerate(usable_classes):
        class_name = cls.name.strip()
        image_count = 0
        for image_index, img in enumerate(cls.images):
            dst_path = f"{gcs_service.ACTION_DATASET_PREFIX}{dataset_id}/{class_index}/{image_index}.jpg"

            if img.cluster_id is not None and img.frame_id is not None:
                src_path = (
                    f"{gcs_service.ACTION_DISCOVERY_TEMP_PREFIX}{user['uid']}/{job_id}/{img.cluster_id}/{img.frame_id}.jpg"
                )
            elif img.storage_path:
                if not img.storage_path.startswith(training_upload_prefix):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Class '{class_name}': invalid image reference.",
                    )
                src_path = img.storage_path
                consumed_training_uploads.append(img.storage_path)
            else:
                raise HTTPException(
                    status_code=400,
                    detail=f"Class '{class_name}': every image needs either a discovered frame reference or an uploaded image.",
                )

            try:
                gcs_service.copy_blob(src_path, dst_path)
            except Exception:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Class '{class_name}': couldn't find image {image_index + 1} — it may have "
                        "already expired. Try refreshing and re-adding it."
                    ),
                )
            image_count += 1

        classes_out.append({"name": class_name, "image_count": image_count})
        total_images += image_count

    created_at = _now_iso()
    dataset_doc = {
        "dataset_id": dataset_id,
        "owner_uid": user["uid"],
        "name": name,
        "source_video_filename": job_data.get("original_filename"),
        "classes": classes_out,
        "total_images": total_images,
        "created_at": created_at,
    }
    db.collection("action_datasets").document(dataset_id).set(dataset_doc)

    gcs_service.delete_blobs_with_prefix(f"{gcs_service.ACTION_DISCOVERY_TEMP_PREFIX}{user['uid']}/{job_id}/")
    for path in consumed_training_uploads:
        gcs_service.delete_blob(path)
    job_ref.delete()

    return _to_dataset_out(dataset_doc)


# ── Saved datasets ───────────────────────────────────────────────────────

@router.get("/datasets", response_model=List[ActionDatasetOut])
def list_datasets(limit: int = 100, user: dict = Depends(get_current_user)):
    db = get_db()
    docs = [d.to_dict() for d in db.collection("action_datasets").where("owner_uid", "==", user["uid"]).stream()]
    docs.sort(key=lambda d: d.get("created_at") or "", reverse=True)
    return [_to_dataset_out(d) for d in docs[:limit]]


@router.get("/datasets/{dataset_id}", response_model=ActionDatasetOut)
def get_dataset(dataset_id: str, user: dict = Depends(get_current_user)):
    db = get_db()
    doc = db.collection("action_datasets").document(dataset_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Dataset not found")
    data = doc.to_dict()
    _check_owner(data, user)
    return _to_dataset_out(data)


@router.get("/datasets/{dataset_id}/classes/{class_index}/images/{image_index}")
def get_dataset_image(
    dataset_id: str, class_index: int, image_index: int, user: dict = Depends(get_current_user)
):
    db = get_db()
    doc = db.collection("action_datasets").document(dataset_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Dataset not found")
    data = doc.to_dict()
    _check_owner(data, user)

    blob_path = f"{gcs_service.ACTION_DATASET_PREFIX}{dataset_id}/{class_index}/{image_index}.jpg"
    try:
        image_bytes = gcs_service.download_bytes(blob_path)
    except Exception:
        raise HTTPException(status_code=404, detail="Image not found.")
    return Response(content=image_bytes, media_type="image/jpeg")


def _delete_orphaned_dataset_blobs(dataset_id: str, classes_out: List[dict]) -> None:
    """After a re-save, delete whatever's left under this dataset's prefix
    that ISN'T one of the just-written final {class_index}/{image_index}.jpg
    paths — an old action that got merged away, deleted, or just shrank
    leaves blobs behind at indices the new layout no longer covers. Listing
    and diffing (rather than trying to reason about old vs. new layouts
    directly) handles every reorder/merge/shrink case uniformly."""
    prefix = f"{gcs_service.ACTION_DATASET_PREFIX}{dataset_id}/"
    final_paths = {
        f"{prefix}{class_index}/{image_index}.jpg"
        for class_index, cls in enumerate(classes_out)
        for image_index in range(cls["image_count"])
    }
    for blob_name in gcs_service.list_blob_names_with_prefix(prefix):
        if blob_name not in final_paths:
            gcs_service.delete_blob(blob_name)


@router.put("/datasets/{dataset_id}", response_model=ActionDatasetOut)
def update_action_dataset(dataset_id: str, payload: UpdateActionDatasetRequest, user: dict = Depends(get_current_user)):
    """Re-saves an existing PERMANENT dataset after the owner renamed/merged/
    added/deleted actions or images in the edit UI — same review UI as a
    fresh discovery job, but sourced from this dataset's OWN stored images
    (class_index/image_index) instead of a discovery job's temp previews.

    Two-phase copy, not one: class_index/image_index numbering can
    legitimately change on every edit (a merge or delete can put action 2's
    images at action 0), and copying directly old-path -> new-path in a
    single pass risks a new path overwriting an old path that hasn't been
    read yet. Phase 1 copies every kept image to a throwaway staging path;
    phase 2 copies from staging into its final slot. Nothing is deleted
    until every copy in both phases has succeeded.
    """
    db = get_db()
    ref = db.collection("action_datasets").document(dataset_id)
    doc = ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Dataset not found")
    data = doc.to_dict()
    _check_owner(data, user)

    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Give this dataset a name.")
    usable_classes = [c for c in payload.classes if c.name.strip() and c.images]
    if len(usable_classes) < 1:
        raise HTTPException(status_code=400, detail="Add at least one action with at least one image.")

    training_upload_prefix = f"training-uploads/{user['uid']}/"
    staging_prefix = f"{gcs_service.ACTION_DATASET_PREFIX}{dataset_id}/.staging-{uuid.uuid4().hex}/"

    # Phase 1 — stage every kept image (existing dataset images AND freshly
    # uploaded ones) at a unique throwaway path, decoupled from both its old
    # and new class_index/image_index so nothing can collide.
    staged_by_class: List[List[str]] = []
    consumed_training_uploads: List[str] = []
    try:
        for cls in usable_classes:
            class_name = cls.name.strip()
            staged_paths: List[str] = []
            for img in cls.images:
                staging_path = f"{staging_prefix}{uuid.uuid4().hex}.jpg"
                if img.class_index is not None and img.image_index is not None:
                    src_path = f"{gcs_service.ACTION_DATASET_PREFIX}{dataset_id}/{img.class_index}/{img.image_index}.jpg"
                elif img.storage_path:
                    if not img.storage_path.startswith(training_upload_prefix):
                        raise HTTPException(
                            status_code=400, detail=f"Action '{class_name}': invalid image reference."
                        )
                    src_path = img.storage_path
                    consumed_training_uploads.append(img.storage_path)
                else:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Action '{class_name}': every image needs either an existing-image reference or an uploaded image.",
                    )
                try:
                    gcs_service.copy_blob(src_path, staging_path)
                except Exception:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Action '{class_name}': couldn't find one of its images — it may have already been removed. Try refreshing.",
                    )
                staged_paths.append(staging_path)
            staged_by_class.append(staged_paths)
    except HTTPException:
        gcs_service.delete_blobs_with_prefix(staging_prefix)
        raise

    # Phase 2 — copy from staging into final {class_index}/{image_index}.jpg
    # slots. Staging blobs were just written above, so these copies can't
    # fail the way phase 1's could.
    classes_out: List[dict] = []
    total_images = 0
    for class_index, (cls, staged_paths) in enumerate(zip(usable_classes, staged_by_class)):
        class_name = cls.name.strip()
        for image_index, staging_path in enumerate(staged_paths):
            dst_path = f"{gcs_service.ACTION_DATASET_PREFIX}{dataset_id}/{class_index}/{image_index}.jpg"
            gcs_service.copy_blob(staging_path, dst_path)
        classes_out.append({"name": class_name, "image_count": len(staged_paths)})
        total_images += len(staged_paths)

    gcs_service.delete_blobs_with_prefix(staging_prefix)
    for path in consumed_training_uploads:
        gcs_service.delete_blob(path)
    _delete_orphaned_dataset_blobs(dataset_id, classes_out)

    updated_doc = {
        **data,
        "name": name,
        "classes": classes_out,
        "total_images": total_images,
    }
    ref.set(updated_doc)
    return _to_dataset_out(updated_doc)


@router.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: str, user: dict = Depends(get_current_user)):
    """Permanently deletes a saved dataset — every image blob under its
    prefix, plus the Firestore doc. This is the ONLY way an action dataset
    ever goes away; nothing here expires or gets swept up automatically."""
    db = get_db()
    ref = db.collection("action_datasets").document(dataset_id)
    doc = ref.get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Dataset not found")
    data = doc.to_dict()
    _check_owner(data, user)

    gcs_service.delete_blobs_with_prefix(f"{gcs_service.ACTION_DATASET_PREFIX}{dataset_id}/")
    ref.delete()
    return {"status": "deleted"}


@router.post("/datasets/{dataset_id}/copy-for-training", response_model=Dict[str, List[TrainingImageRef]])
def copy_dataset_for_training(dataset_id: str, payload: CopyForTrainingRequest, user: dict = Depends(get_current_user)):
    """Used by the Train page's "Import from saved dataset" option. Makes
    the caller FRESH, DISPOSABLE copies of the requested classes' images
    under training-uploads/ — never hands training_pipeline.py a storage
    path inside action-datasets/, since that pipeline deletes every
    training image once training succeeds, and that must never touch a
    permanent dataset's originals. class_names=None copies every class."""
    db = get_db()
    doc = db.collection("action_datasets").document(dataset_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Dataset not found")
    data = doc.to_dict()
    _check_owner(data, user)

    wanted = set(payload.class_names) if payload.class_names else None
    result: Dict[str, List[TrainingImageRef]] = {}
    for class_index, cls in enumerate(data.get("classes", [])):
        if wanted is not None and cls["name"] not in wanted:
            continue
        refs: List[TrainingImageRef] = []
        for image_index in range(cls.get("image_count", 0)):
            src_path = f"{gcs_service.ACTION_DATASET_PREFIX}{dataset_id}/{class_index}/{image_index}.jpg"
            dst_path = f"training-uploads/{user['uid']}/{uuid.uuid4().hex}.jpg"
            gcs_service.copy_blob(src_path, dst_path)
            refs.append(TrainingImageRef(storage_path=dst_path))
        result[cls["name"]] = refs
    return result
