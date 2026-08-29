"""Pydantic request/response models for the sidecar's local HTTP API — the
offline-desktop counterpart of backend/app/schemas.py's job-related models,
trimmed to what a single local user actually needs (no owner_uid, no auth)."""
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


class _Base(BaseModel):
    """Pydantic v2 reserves the `model_` prefix for its own attributes and
    warns on every field that starts with it — and this API is full of
    legitimately-named ones (`model_id`, `model_name`), matching the cloud
    backend's schema field-for-field. Clearing the protected namespace here
    keeps those names rather than renaming the whole API around a framework
    detail."""

    model_config = ConfigDict(protected_namespaces=())


class JobCreateRequest(_Base):
    """Sent by the Flutter app after the user has picked a video file via
    the OS file picker. Unlike the cloud backend, this is a real local path
    on the user's own disk, not a Cloud Storage blob path — there's no
    upload step at all; the sidecar just opens the file where it already
    is."""
    video_path: str
    original_filename: Optional[str] = None  # defaults to the video_path's basename
    fps: int = 2
    # None -> "use the active model", falling back to the bundled default if
    # no model has been activated (mirrors the web app's "Use active model"
    # dropdown option). Pass DEFAULT_MODEL_ID to force the bundled default.
    model_id: Optional[str] = None


class SceneRow(BaseModel):
    start_time: str
    end_time: str
    duration: str
    action: str
    confidence: float
    source: str


class JobOut(_Base):
    job_id: str
    status: str  # queued | processing | done | failed
    video_path: str
    original_filename: str
    display_name: Optional[str] = None
    model_id: Optional[str] = None
    fps: int
    scene_count: Optional[int] = None
    scenes: Optional[list[SceneRow]] = None
    error: Optional[str] = None
    created_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


class JobRenameRequest(BaseModel):
    display_name: str


class LogImportRequest(_Base):
    """Like JobCreateRequest, this is a real local path — the Flutter app
    picks the CSV with the OS file picker and hands over where it already
    is, rather than uploading its bytes."""
    csv_path: str


# ── Action discovery ("Create actions") ───────────────────────────────────


class DiscoverRequest(_Base):
    video_path: str
    fps: int = 2
    min_cluster_size: int = 5


class DiscoveredCluster(_Base):
    id: str
    name: str
    frame_count: int


class DiscoveryJobOut(_Base):
    discovery_job_id: str
    status: str  # queued | processing | done | failed
    video_path: str
    original_filename: str
    fps: int
    min_cluster_size: int
    clusters: Optional[list[DiscoveredCluster]] = None
    progress: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    created_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


class SaveDatasetAction(_Base):
    """One reviewed, possibly-renamed, possibly-merged action.

    `images` are ABSOLUTE local paths — whether a frame from a discovery
    run's temp folder, an image already in a saved dataset, or one the user
    just picked off their disk. Keeping all three as plain paths is what
    lets one endpoint serve both "save a new discovery run" and "update an
    edited dataset", and lets the UI drag an image between actions without
    caring where it came from. Merging two actions is just concatenating
    their image lists under one name, so there's no separate merge verb.
    """
    name: str
    images: list[str]


class SaveDatasetRequest(_Base):
    name: str
    actions: list[SaveDatasetAction]
    # When this came from reviewing a discovery run, its id — so the run's
    # temp previews and its row can be cleaned up once the kept images are
    # safely copied. Absent when editing an already-saved dataset.
    discovery_job_id: Optional[str] = None


class ActionDatasetOut(_Base):
    dataset_id: str
    name: str
    # {action name: image count} — enough for the list UI without shipping
    # every path; the Train screen fetches full paths separately.
    action_counts: dict[str, int]
    created_at: str


# ── Analytics (SPM / DSM) ─────────────────────────────────────────────────


class SPMRequest(_Base):
    job_ids: list[str]
    min_support: float = 0.4  # "S support threshold" — fraction of sequences a pattern must appear in
    top_k: int = 10
    # Advanced options — defaults reproduce plain unconstrained PrefixSpan.
    # See app/sequence_mining.py's docstring for the terminology.
    sliding_window_min: int = 1  # shortest pattern length considered
    sliding_window_max: int = 4  # longest considered (also capped by MAX_PATTERN_LEN)
    min_gap: int = 0  # min # of other events allowed between consecutive pattern items
    max_gap: Optional[int] = None  # max # allowed; None = unlimited
    min_instance_support: float = 0.0  # "I support threshold" — min mean instances/sequence
    sort_by: str = "s_support"  # "s_support" | "i_support"


class SPMPattern(_Base):
    pattern: list[str]
    support: int  # S-frequency: # of sequences containing the pattern at least once
    support_fraction: float  # S-support: support / total sequences
    i_frequency: int = 0  # total non-overlapping occurrences across ALL sequences
    i_support_mean: float = 0.0  # i_frequency / total sequences (zeros included)
    i_support_sd: float = 0.0  # population stdev of per-sequence instance counts


class DSMRequest(_Base):
    group_a_job_ids: list[str]
    group_b_job_ids: list[str]
    min_support: float = 0.4
    top_k: int = 10
    sliding_window_min: int = 1
    sliding_window_max: int = 4
    min_gap: int = 0
    max_gap: Optional[int] = None
    min_instance_support: float = 0.0
    # DSM-specific: which scipy.stats two-independent-samples test compares a
    # pattern's per-video I-support between groups, and the cutoff to filter
    # on. See app/analytics.py::TEST_TYPES for the allowed set.
    test_type: str = "ttest_ind"
    threshold_p_value: float = 0.1


class DSMPattern(_Base):
    pattern: list[str]
    p_value: float
    isupport_left_mean: Optional[float] = None  # populated only when group == "left"
    isupport_right_mean: Optional[float] = None  # populated only when group == "right"
    group: str  # "left" (group A) | "right" (group B) — which group this is characteristic of


class ActionDatasetDetail(_Base):
    dataset_id: str
    name: str
    created_at: str
    # {action name: [absolute image paths]} — exactly the shape
    # POST /train's `dataset` field expects, so importing a dataset into
    # training is a straight pass-through.
    actions: dict[str, list[str]]


# ── Training ──────────────────────────────────────────────────────────────


class ScanFolderRequest(BaseModel):
    """Points at a folder whose SUBFOLDERS are action names — see
    app/training_pipeline.py::scan_dataset_folder."""
    folder_path: str


class ScannedAction(BaseModel):
    name: str
    image_count: int
    image_paths: list[str]


class ScanFolderResponse(BaseModel):
    actions: list[ScannedAction]


class SplitConfig(BaseModel):
    train: float = 0.7
    val: float = 0.15
    test: float = 0.15


class TrainRequest(_Base):
    model_name: str
    # {action_name: [absolute image paths]}. These are the user's own files,
    # read in place — nothing is uploaded or copied anywhere permanent.
    dataset: dict[str, list[str]]
    epochs: int = 20
    batch_size: int = 16
    learning_rate: float = 0.001
    split: SplitConfig = SplitConfig()


class TrainingJobOut(_Base):
    training_job_id: str
    status: str  # queued | processing | done | failed
    model_name: str
    dataset: dict[str, list[str]]
    epochs: int
    batch_size: int
    learning_rate: float
    split: Optional[dict[str, float]] = None
    # Free-form so the pipeline can report whatever's relevant per stage
    # (epoch counts during training, a text detail during OCR, etc.) without
    # this schema needing a field per stage.
    progress: Optional[dict[str, Any]] = None
    model_id: Optional[str] = None
    metrics: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    created_at: str
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


# ── Models ────────────────────────────────────────────────────────────────


class ModelOut(_Base):
    model_id: str
    name: str
    labels: list[str]
    fusion_alpha: Optional[float] = None
    fusion_alpha_per_class: Optional[dict[str, float]] = None
    metrics: Optional[dict[str, Any]] = None
    is_active: bool
    dataset_version: Optional[str] = None
    created_at: str
    # True only for the bundled default pseudo-model, which has no registry
    # row and can't be renamed or deleted (see DEFAULT_MODEL_ID in main.py).
    is_bundled: bool = False


class ModelRenameRequest(_Base):
    name: str
