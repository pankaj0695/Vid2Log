"""
The sidecar's local HTTP API — the offline-desktop counterpart of the cloud
backend's FastAPI app (backend/app/main.py), talked to over 127.0.0.1 only
by the Flutter shell (lib/services/api_client.dart), never exposed on any
other interface and never reachable off the user's own machine.

Deliberately dropped versus the cloud backend: auth (Depends(get_current_user)
everywhere there) — there's exactly one user, this process, on this machine,
so every "owner_uid" check the cloud version does is meaningless here and
just adds ceremony. CORS middleware is also skipped — Flutter desktop's HTTP
client isn't a browser, so there's no origin to allow.
"""
import csv
import io
import logging
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from app import analytics
from app.bundle import resource_dir
from app.config import ACTION_DATASETS_DIR, DISCOVERY_TEMP_DIR, MODELS_DIR
from app.db import delete_action_dataset as db_delete_action_dataset
from app.db import delete_discovery_job as db_delete_discovery_job
from app.db import delete_job as db_delete_job
from app.db import delete_model as db_delete_model
from app.db import delete_training_job as db_delete_training_job
from app.db import update_action_dataset as update_action_dataset_row
from app.db import (
    get_action_dataset,
    get_active_model,
    get_discovery_job,
    get_job,
    get_model,
    get_training_job,
    init_db,
    insert_action_dataset,
    insert_discovery_job,
    insert_job,
    insert_training_job,
    list_action_datasets,
    list_discovery_jobs,
    list_jobs,
    list_models,
    list_training_jobs,
    set_active_model,
    update_job,
    update_model,
    update_training_job,
)
from app.schemas import (
    ActionDatasetDetail,
    ActionDatasetOut,
    DiscoverRequest,
    DiscoveryJobOut,
    DSMPattern,
    DSMRequest,
    SPMPattern,
    SPMRequest,
    JobCreateRequest,
    JobOut,
    JobRenameRequest,
    LogImportRequest,
    ModelOut,
    ModelRenameRequest,
    SaveDatasetRequest,
    ScanFolderRequest,
    ScanFolderResponse,
    TrainingJobOut,
    TrainRequest,
)
from app.video_pipeline import submit_discovery_job, submit_job, submit_training_job

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

app = FastAPI(title="vid2log sidecar")

# Sentinel model_id meaning "the CNN bundled inside the app"
# (app/ml/default_model/). It has no registry row — the UI needs a stable
# id to put in a dropdown and store on a job, and `null` can't serve that
# purpose because null already means "whatever's active right now".
DEFAULT_MODEL_ID = "__default__"

# Columns a hand-built/externally-produced log CSV must have to be imported
# via POST /logs/import — matches GET /jobs/{id}/csv's export format exactly
# (minus `source`, optional in both) so export-then-reimport round-trips.
REQUIRED_IMPORT_COLUMNS = {"start_time", "end_time", "duration", "action", "confidence"}

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".bmp", ".webp"}


@app.on_event("startup")
def _startup() -> None:
    init_db()
    log.info("vid2log sidecar ready.")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/jobs", response_model=JobOut)
def create_job(payload: JobCreateRequest):
    video_path = Path(payload.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=400, detail=f"File not found: {video_path}")

    job_id = str(uuid.uuid4())
    original_filename = payload.original_filename or video_path.name

    # Resolve "use the active model" (model_id=None) at CREATION time, not at
    # processing time, so the job permanently records which model actually
    # ran it — activating a different model later must not retroactively
    # change what an old job's log claims to have been produced with.
    model_id = payload.model_id
    if model_id is None:
        active = get_active_model()
        model_id = active["model_id"] if active else DEFAULT_MODEL_ID
    if model_id != DEFAULT_MODEL_ID and get_model(model_id) is None:
        raise HTTPException(status_code=400, detail=f"Model not found: {model_id}")

    job = {
        "job_id": job_id,
        "status": "queued",
        "video_path": str(video_path),
        "original_filename": original_filename,
        "display_name": None,
        "model_id": model_id,
        "fps": payload.fps,
        "created_at": _now_iso(),
    }
    insert_job(job)
    submit_job(job_id)

    return JobOut(**job)


@app.get("/jobs", response_model=list[JobOut])
def get_jobs(limit: int = 50):
    return [JobOut(**j) for j in list_jobs(limit=limit)]


@app.get("/jobs/{job_id}", response_model=JobOut)
def get_job_detail(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobOut(**job)


@app.patch("/jobs/{job_id}", response_model=JobOut)
def rename_job(job_id: str, payload: JobRenameRequest):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    name = payload.display_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")
    update_job(job_id, {"display_name": name})
    job["display_name"] = name
    return JobOut(**job)


@app.delete("/jobs/{job_id}")
def delete_job(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] == "processing":
        raise HTTPException(status_code=409, detail="Job is still processing — wait for it to finish.")
    db_delete_job(job_id)
    return {"status": "deleted"}


@app.get("/jobs/{job_id}/csv")
def get_job_csv(job_id: str):
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail=f"Job is '{job['status']}', not ready yet.")

    buffer = io.StringIO()
    writer = csv.DictWriter(
        buffer,
        fieldnames=["start_time", "end_time", "duration", "action", "confidence", "source"],
        extrasaction="ignore",
    )
    writer.writeheader()
    for row in job.get("scenes") or []:
        writer.writerow(row)
    buffer.seek(0)

    filename = f"{job['original_filename'].rsplit('.', 1)[0]}_analysis.csv"
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/logs/import", response_model=JobOut)
def import_csv_log(payload: LogImportRequest):
    """Creates a 'done' job/log directly from a CSV of scene rows, for logs
    that already exist outside vid2log (produced by hand, exported from
    elsewhere, or exported from this app and edited). Skips the video
    pipeline entirely — the CSV's rows become the scenes as-is, in the same
    shape GET /jobs/{id}/csv exports, so export-then-reimport round-trips.

    Validation is ported from backend/app/routers/logs.py::import_csv_log,
    but the CSV arrives as a local PATH rather than an upload, matching how
    videos work here (see JobCreateRequest)."""
    csv_path = Path(payload.csv_path)
    if not csv_path.is_file():
        raise HTTPException(status_code=400, detail=f"File not found: {csv_path}")

    try:
        # utf-8-sig tolerates the BOM Excel writes on CSV export.
        text = csv_path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded text.")

    reader = csv.DictReader(io.StringIO(text))
    present = set(reader.fieldnames or [])
    missing = sorted(REQUIRED_IMPORT_COLUMNS - present)
    if reader.fieldnames is None or missing:
        raise HTTPException(
            status_code=400,
            detail=(
                f"CSV is missing required column{'s' if len(missing) != 1 else ''}: "
                f"{', '.join(missing) or ', '.join(sorted(REQUIRED_IMPORT_COLUMNS))}."
            ),
        )

    scenes = []
    for i, row in enumerate(reader, start=2):  # row 1 is the header
        for col in REQUIRED_IMPORT_COLUMNS:
            if not (row.get(col) or "").strip():
                raise HTTPException(status_code=400, detail=f"Row {i}: '{col}' is empty.")
        try:
            confidence = float(row["confidence"])
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Row {i}: 'confidence' must be a number.")
        scenes.append(
            {
                "start_time": row["start_time"].strip(),
                "end_time": row["end_time"].strip(),
                "duration": row["duration"].strip(),
                "action": row["action"].strip(),
                "confidence": confidence,
                "source": (row.get("source") or "csv_import").strip(),
            }
        )

    if not scenes:
        raise HTTPException(status_code=400, detail="CSV has no data rows.")

    job_id = str(uuid.uuid4())
    now = _now_iso()
    job = {
        "job_id": job_id,
        "status": "done",
        # There's no video behind an imported log. Recording the CSV's own
        # path keeps the row honest about where this came from, rather than
        # inventing a video path that was never processed.
        "video_path": str(csv_path),
        "original_filename": csv_path.name,
        "display_name": None,
        "model_id": None,
        "fps": 0,
        "created_at": now,
    }
    insert_job(job)
    update_job(
        job_id,
        {
            "status": "done",
            "scene_count": len(scenes),
            "scenes": scenes,
            "started_at": now,
            "completed_at": now,
        },
    )
    return JobOut(**get_job(job_id))


# ── Training ──────────────────────────────────────────────────────────────


@app.post("/train/scan-folder", response_model=ScanFolderResponse)
def scan_folder(payload: ScanFolderRequest):
    """Preview what a dataset folder contains, without training anything —
    each subfolder becomes one action. See training_pipeline's
    scan_dataset_folder for the expected layout."""
    from app.training_pipeline import scan_dataset_folder

    folder = Path(payload.folder_path)
    if not folder.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a folder: {folder}")

    actions = scan_dataset_folder(folder)
    if not actions:
        raise HTTPException(
            status_code=400,
            detail=(
                "No action subfolders with images found. This folder should contain "
                "one subfolder per action, each holding that action's screenshots."
            ),
        )
    return ScanFolderResponse(actions=actions)


@app.post("/train", response_model=TrainingJobOut)
def start_training(payload: TrainRequest):
    if len(payload.dataset) < 2:
        raise HTTPException(status_code=400, detail="Training needs at least 2 actions to tell apart.")

    split = payload.split
    total = split.train + split.val + split.test
    if abs(total - 1.0) > 0.01:
        raise HTTPException(status_code=400, detail=f"Split fractions must add up to 1.0 (got {total:.2f}).")

    training_job_id = str(uuid.uuid4())
    job = {
        "training_job_id": training_job_id,
        "status": "queued",
        "model_name": payload.model_name.strip() or f"model-{training_job_id[:8]}",
        "dataset": payload.dataset,
        "epochs": payload.epochs,
        "batch_size": payload.batch_size,
        "learning_rate": payload.learning_rate,
        "split": split.model_dump(),
        "created_at": _now_iso(),
    }
    insert_training_job(job)
    submit_training_job(training_job_id)

    return TrainingJobOut(**get_training_job(training_job_id))


@app.get("/train", response_model=list[TrainingJobOut])
def get_training_jobs(limit: int = 50):
    return [TrainingJobOut(**j) for j in list_training_jobs(limit=limit)]


@app.get("/train/{training_job_id}", response_model=TrainingJobOut)
def get_training_job_detail(training_job_id: str):
    job = get_training_job(training_job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Training job not found")
    return TrainingJobOut(**job)


@app.post("/train/{training_job_id}/retry", response_model=TrainingJobOut)
def retry_training(training_job_id: str):
    """Re-queues the SAME training job row (same id, same dataset) rather
    than creating a new one — so a retried run keeps its place in history
    instead of appearing as a duplicate. Mirrors the cloud backend's
    POST /train/{id}/retry."""
    job = get_training_job(training_job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Training job not found")
    if job["status"] in ("queued", "processing"):
        raise HTTPException(status_code=409, detail=f"Job is already {job['status']}.")

    update_training_job(
        training_job_id,
        {
            "status": "queued",
            "error": None,
            "progress": None,
            "started_at": None,
            "completed_at": None,
        },
    )
    submit_training_job(training_job_id)
    return TrainingJobOut(**get_training_job(training_job_id))


@app.delete("/train/{training_job_id}")
def delete_training_job(training_job_id: str):
    job = get_training_job(training_job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Training job not found")
    if job["status"] == "processing":
        raise HTTPException(status_code=409, detail="Training is still running — wait for it to finish.")
    db_delete_training_job(training_job_id)
    return {"status": "deleted"}


# ── Models ────────────────────────────────────────────────────────────────


def _bundled_model_entry(any_active: bool) -> ModelOut:
    """The bundled default, presented as a normal registry entry so the UI
    can list and select it alongside trained models. It's flagged
    `is_bundled` so the UI knows to hide rename/delete for it, and it reads
    as active exactly when nothing else is."""
    # Via resource_dir(), not __file__ — see app/bundle.py for why that
    # distinction matters once this is frozen into an executable.
    labels_path = resource_dir() / "app" / "ml" / "default_model" / "labels.txt"
    labels: list[str] = []
    if labels_path.exists():
        labels = [line.strip() for line in labels_path.read_text().splitlines() if line.strip()]

    return ModelOut(
        model_id=DEFAULT_MODEL_ID,
        name="Default model (bundled)",
        labels=labels,
        is_active=not any_active,
        created_at="",
        is_bundled=True,
    )


@app.get("/models", response_model=list[ModelOut])
def get_models():
    rows = list_models()
    models = [ModelOut(**{**r, "is_active": bool(r["is_active"]), "is_bundled": False}) for r in rows]
    return [_bundled_model_entry(any(m.is_active for m in models))] + models


@app.get("/models/{model_id}", response_model=ModelOut)
def get_model_detail(model_id: str):
    if model_id == DEFAULT_MODEL_ID:
        return _bundled_model_entry(get_active_model() is not None)
    row = get_model(model_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Model not found")
    return ModelOut(**{**row, "is_active": bool(row["is_active"]), "is_bundled": False})


@app.post("/models/{model_id}/activate")
def activate_model(model_id: str):
    if model_id == DEFAULT_MODEL_ID:
        # "Activate the bundled model" just means "no trained model is
        # active" — the bundled one is the fallback, so it doesn't need (or
        # have) a registry row to flag.
        active = get_active_model()
        if active is not None:
            update_model(active["model_id"], {"is_active": 0})
        return {"status": "activated", "model_id": DEFAULT_MODEL_ID}

    if get_model(model_id) is None:
        raise HTTPException(status_code=404, detail="Model not found")
    set_active_model(model_id)
    return {"status": "activated", "model_id": model_id}


@app.patch("/models/{model_id}", response_model=ModelOut)
def rename_model(model_id: str, payload: ModelRenameRequest):
    if model_id == DEFAULT_MODEL_ID:
        raise HTTPException(status_code=400, detail="The bundled model can't be renamed.")
    if get_model(model_id) is None:
        raise HTTPException(status_code=404, detail="Model not found")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")
    update_model(model_id, {"name": name})
    row = get_model(model_id)
    return ModelOut(**{**row, "is_active": bool(row["is_active"]), "is_bundled": False})


@app.delete("/models/{model_id}")
def delete_model(model_id: str):
    if model_id == DEFAULT_MODEL_ID:
        raise HTTPException(status_code=400, detail="The bundled model can't be deleted.")
    if get_model(model_id) is None:
        raise HTTPException(status_code=404, detail="Model not found")

    db_delete_model(model_id)
    # Drop the weights too — otherwise MODELS_DIR grows forever with
    # orphaned directories nothing references.
    shutil.rmtree(MODELS_DIR / model_id, ignore_errors=True)
    return {"status": "deleted"}


# ── Action discovery ("Create actions") ───────────────────────────────────


@app.post("/actions/discover", response_model=DiscoveryJobOut)
def start_discovery(payload: DiscoverRequest):
    video_path = Path(payload.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=400, detail=f"File not found: {video_path}")
    if payload.min_cluster_size < 2:
        raise HTTPException(status_code=400, detail="Min cluster size must be at least 2.")

    discovery_job_id = str(uuid.uuid4())
    insert_discovery_job(
        {
            "discovery_job_id": discovery_job_id,
            "status": "queued",
            "video_path": str(video_path),
            "original_filename": video_path.name,
            "fps": payload.fps,
            "min_cluster_size": payload.min_cluster_size,
            "created_at": _now_iso(),
        }
    )
    submit_discovery_job(discovery_job_id)
    return DiscoveryJobOut(**get_discovery_job(discovery_job_id))


@app.get("/actions/discover", response_model=list[DiscoveryJobOut])
def get_discovery_jobs(limit: int = 50):
    return [DiscoveryJobOut(**j) for j in list_discovery_jobs(limit=limit)]


@app.get("/actions/discover/{discovery_job_id}", response_model=DiscoveryJobOut)
def get_discovery_detail(discovery_job_id: str):
    job = get_discovery_job(discovery_job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Discovery job not found")
    return DiscoveryJobOut(**job)


@app.get("/actions/discover/{discovery_job_id}/frames/{cluster_id}")
def list_cluster_frames(discovery_job_id: str, cluster_id: str):
    """Absolute paths of one proposed action's preview frames.

    Real paths rather than opaque ids because the Flutter app renders these
    with Image.file straight off disk — it's a desktop app on the same
    machine, so round-tripping every thumbnail through HTTP would be pure
    overhead. It also means a discovery frame, a saved dataset's image, and
    a file the user just picked are all the same kind of thing to the review
    UI, which is what makes dragging an image between actions work
    regardless of where it came from.
    """
    cluster_dir = DISCOVERY_TEMP_DIR / discovery_job_id / cluster_id
    if not cluster_dir.is_dir():
        raise HTTPException(status_code=404, detail="No frames for this action")
    frames = sorted(
        (p for p in cluster_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES),
        # Frames are written as 0.jpg, 1.jpg, ... — sort by length first so
        # 10.jpg doesn't land between 1.jpg and 2.jpg.
        key=lambda p: (len(p.name), p.name),
    )
    return {"frames": [str(p) for p in frames]}


@app.delete("/actions/discover/{discovery_job_id}")
def delete_discovery(discovery_job_id: str):
    job = get_discovery_job(discovery_job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Discovery job not found")
    if job["status"] == "processing":
        raise HTTPException(status_code=409, detail="Discovery is still running — wait for it to finish.")
    db_delete_discovery_job(discovery_job_id)
    shutil.rmtree(DISCOVERY_TEMP_DIR / discovery_job_id, ignore_errors=True)
    return {"status": "deleted"}


def _validate_actions(payload: SaveDatasetRequest) -> list:
    actions = [a for a in payload.actions if a.images]
    if len(actions) < 2:
        raise HTTPException(
            status_code=400, detail="Keep at least 2 actions with images — a model needs 2 classes to tell apart."
        )
    names = [a.name.strip() for a in actions]
    if any(not n for n in names):
        raise HTTPException(status_code=400, detail="Every action needs a name.")
    if len(set(names)) != len(names):
        raise HTTPException(status_code=400, detail="Two actions have the same name — merge them or rename one.")
    return actions


def _write_dataset_dir(actions: list, dest_root: Path) -> dict[str, int]:
    """Copies every action's images into dest_root/{action}/, returning
    {action name: image count}. Copies (never moves) so the sources — which
    may be the user's own files, or this dataset's own current images
    during an edit — are left untouched."""
    counts: dict[str, int] = {}
    for action in actions:
        name = action.name.strip()
        # Names become real directory names, so a "/" or ".." in one would
        # otherwise write outside the dataset folder entirely.
        safe_name = name.replace("/", "-").replace("\\", "-").strip(". ")
        if not safe_name:
            raise HTTPException(status_code=400, detail=f"'{name}' isn't a usable action name.")

        dest_dir = dest_root / safe_name
        dest_dir.mkdir(parents=True, exist_ok=True)

        written = 0
        for raw in action.images:
            src = Path(raw)
            if not src.is_file() or src.suffix.lower() not in IMAGE_SUFFIXES:
                # A stale reference (file moved/deleted since review started)
                # is skipped rather than failing the whole save — the empty
                # -action check below still catches the case where that
                # leaves an action with nothing in it.
                continue
            shutil.copy(src, dest_dir / f"{written}{src.suffix.lower()}")
            written += 1

        if written == 0:
            raise HTTPException(status_code=400, detail=f"'{name}' has no usable images left.")
        counts[safe_name] = written
    return counts


@app.post("/actions/datasets", response_model=ActionDatasetOut)
def create_action_dataset(payload: SaveDatasetRequest):
    """Saves a reviewed set of actions as a permanent, reusable dataset.

    Images are copied into ACTION_DATASETS_DIR/{dataset_id}/{action}/, which
    is exactly the subfolder-per-action layout
    training_pipeline.scan_dataset_folder reads — so a saved dataset feeds
    straight into training with no conversion step.

    `discovery_job_id` is optional: present when this came from reviewing a
    discovery run (so its temp previews get cleaned up afterwards), absent
    when the actions were assembled some other way.
    """
    actions = _validate_actions(payload)

    dataset_id = str(uuid.uuid4())
    dataset_dir = ACTION_DATASETS_DIR / dataset_id
    try:
        action_counts = _write_dataset_dir(actions, dataset_dir)
    except Exception:
        # Don't leave a half-written dataset behind for the user to find.
        shutil.rmtree(dataset_dir, ignore_errors=True)
        raise

    insert_action_dataset(
        {
            "dataset_id": dataset_id,
            "name": payload.name.strip() or f"Dataset {dataset_id[:8]}",
            "action_counts": action_counts,
            "created_at": _now_iso(),
        }
    )

    # The kept images are safely copied now — drop the run's temp previews
    # and its row, the same "temporary until reviewed and kept" policy the
    # cloud version uses.
    if payload.discovery_job_id:
        shutil.rmtree(DISCOVERY_TEMP_DIR / payload.discovery_job_id, ignore_errors=True)
        db_delete_discovery_job(payload.discovery_job_id)

    return ActionDatasetOut(**get_action_dataset(dataset_id))


@app.put("/actions/datasets/{dataset_id}", response_model=ActionDatasetOut)
def update_action_dataset(dataset_id: str, payload: SaveDatasetRequest):
    """Replaces a saved dataset's contents with an edited set of actions.

    Written to a sibling directory first and swapped in only once every copy
    has succeeded. That ordering isn't fussiness: an edit's image paths
    usually point INTO this dataset's own current folder (that's where its
    existing images live), so clearing the folder first would delete the very
    files being copied from. Building alongside also means a failure halfway
    through leaves the original dataset perfectly intact.
    """
    if get_action_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    actions = _validate_actions(payload)

    current_dir = ACTION_DATASETS_DIR / dataset_id
    staging_dir = ACTION_DATASETS_DIR / f".{dataset_id}.updating"
    shutil.rmtree(staging_dir, ignore_errors=True)

    try:
        action_counts = _write_dataset_dir(actions, staging_dir)
    except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise

    shutil.rmtree(current_dir, ignore_errors=True)
    staging_dir.rename(current_dir)

    update_action_dataset_row(
        dataset_id,
        {
            "name": payload.name.strip() or f"Dataset {dataset_id[:8]}",
            "action_counts": action_counts,
        },
    )
    return ActionDatasetOut(**get_action_dataset(dataset_id))


@app.get("/actions/datasets", response_model=list[ActionDatasetOut])
def get_action_datasets():
    return [ActionDatasetOut(**d) for d in list_action_datasets()]


@app.get("/actions/datasets/{dataset_id}", response_model=ActionDatasetDetail)
def get_action_dataset_detail(dataset_id: str):
    """Full image paths per action — the shape POST /train's `dataset` field
    wants, so the Train screen can import a dataset as a straight
    pass-through."""
    dataset = get_action_dataset(dataset_id)
    if dataset is None:
        raise HTTPException(status_code=404, detail="Dataset not found")

    dataset_dir = ACTION_DATASETS_DIR / dataset_id
    actions: dict[str, list[str]] = {}
    if dataset_dir.is_dir():
        for action_dir in sorted(dataset_dir.iterdir()):
            if not action_dir.is_dir():
                continue
            actions[action_dir.name] = sorted(
                str(p) for p in action_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES
            )

    return ActionDatasetDetail(
        dataset_id=dataset_id,
        name=dataset["name"],
        created_at=dataset["created_at"],
        actions=actions,
    )


@app.delete("/actions/datasets/{dataset_id}")
def delete_action_dataset_endpoint(dataset_id: str):
    if get_action_dataset(dataset_id) is None:
        raise HTTPException(status_code=404, detail="Dataset not found")
    db_delete_action_dataset(dataset_id)
    shutil.rmtree(ACTION_DATASETS_DIR / dataset_id, ignore_errors=True)
    return {"status": "deleted"}


# ── Analytics (SPM / DSM) ─────────────────────────────────────────────────


@app.post("/analytics/spm", response_model=list[SPMPattern])
def sequential_pattern_mining(payload: SPMRequest):
    """Frequent activity sub-sequences across the given logs — surfaces
    common workflows, loops and rework. Reports both S-support (how many
    logs contain the pattern) and I-support (how often it occurs per log),
    with optional gap/window constraints. See app/analytics.py."""
    if not payload.job_ids:
        raise HTTPException(status_code=400, detail="Select at least one log.")

    sequences = [analytics.job_sequence(jid) for jid in payload.job_ids]
    rows = analytics.spm_analyze(
        sequences,
        s_support_threshold=payload.min_support,
        i_support_threshold=payload.min_instance_support,
        sliding_window_min=payload.sliding_window_min,
        sliding_window_max=payload.sliding_window_max,
        min_gap=payload.min_gap,
        max_gap=payload.max_gap,
        sort_by=payload.sort_by,
        top_k=payload.top_k,
    )
    return [SPMPattern(**r) for r in rows]


@app.post("/analytics/dsm", response_model=list[DSMPattern])
def differential_sequence_mining(payload: DSMRequest):
    """Compares two groups of logs (e.g. high- vs low-performing sessions):
    mines each group's own frequent patterns, then runs a configurable
    statistical test on each pattern's per-log I-support between groups,
    keeping only those clearing the p-value threshold — the "what's actually
    significantly different" answer, not just a raw support diff."""
    if payload.test_type not in analytics.TEST_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown test type '{payload.test_type}'. Must be one of {sorted(analytics.TEST_TYPES)}.",
        )
    if not payload.group_a_job_ids or not payload.group_b_job_ids:
        raise HTTPException(status_code=400, detail="Both groups need at least one log.")

    seqs_a = [analytics.job_sequence(jid) for jid in payload.group_a_job_ids]
    seqs_b = [analytics.job_sequence(jid) for jid in payload.group_b_job_ids]

    rows = analytics.dsm_analyze(
        seqs_a,
        seqs_b,
        s_support_threshold=payload.min_support,
        i_support_threshold=payload.min_instance_support,
        sliding_window_min=payload.sliding_window_min,
        sliding_window_max=payload.sliding_window_max,
        min_gap=payload.min_gap,
        max_gap=payload.max_gap,
        test_type=payload.test_type,
        threshold_p_value=payload.threshold_p_value,
        top_k=payload.top_k,
    )
    return [DSMPattern(**r) for r in rows]


@app.get("/analytics/test-types")
def get_test_types():
    """The statistical tests the DSM tab can offer — served rather than
    hardcoded in the UI so the two can't drift apart."""
    return {"test_types": sorted(analytics.TEST_TYPES)}
