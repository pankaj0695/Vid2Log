"""Pydantic request/response models for the vid2log API."""
from typing import Dict, List, Optional

from pydantic import BaseModel, Field


# ── Users (auth / roles) ────────────────────────────────────────────────────

class UserBootstrapRequest(BaseModel):
    """Sent right after a successful Firebase sign-in/sign-up. `display_name`
    is only needed for email/password accounts — Google sign-in already
    carries a name on the decoded ID token. Deliberately carries no `role`
    field: role always defaults server-side to "user" on first creation and
    is left untouched on every later call, so a client can never grant
    itself admin — that only ever happens by hand in Firestore."""
    display_name: Optional[str] = None


class UserProfile(BaseModel):
    uid: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    role: str = "user"  # "user" | "admin"
    created_at: Optional[str] = None


class UserRoleUpdateRequest(BaseModel):
    role: str  # "user" | "admin"


class SignedUploadRequest(BaseModel):
    """Requested by the frontend BEFORE it uploads a file — the backend
    hands back a short-lived URL the browser can PUT the raw bytes to
    directly on Google Cloud Storage, so the file never passes through our
    own server. `kind` controls where in the bucket the blob is placed and
    is restricted to a small allow-list (see routers/uploads.py) so a client
    can't write outside its own uid-scoped prefix."""
    filename: str
    content_type: str
    kind: str  # "video" | "training-image" | "model-file"


class SignedUploadResponse(BaseModel):
    upload_url: str  # PUT here with header Content-Type matching content_type above
    storage_path: str  # pass this back to /jobs or /train as storage_path


class AdminStats(BaseModel):
    total_users: int
    total_admins: int
    total_jobs: int
    jobs_by_status: Dict[str, int]
    total_models: int
    active_model_id: Optional[str] = None
    total_training_jobs: int


# ── Jobs (video processing) ─────────────────────────────────────────────────

class JobCreateRequest(BaseModel):
    """
    Sent by the frontend *after* it has already uploaded the video directly to
    Cloud Storage using a signed URL obtained from POST /uploads/signed-url.
    We never receive the raw video bytes here — only the blob path it was
    uploaded to.
    """
    storage_path: str
    resource_type: str = "video"
    original_filename: str
    fps: int = 2
    model_id: Optional[str] = None  # None -> use the currently active model


class JobOut(BaseModel):
    job_id: str
    status: str  # queued | processing | done | failed | cancelled
    original_filename: str
    # User-set override shown in place of original_filename once renamed
    # (see PATCH /jobs/{id}) — original_filename itself never changes, so
    # things like the default CSV download name still make sense.
    display_name: Optional[str] = None
    model_id: Optional[str] = None
    scene_count: Optional[int] = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


class JobRenameRequest(BaseModel):
    display_name: str


class SceneRow(BaseModel):
    start_time: str
    end_time: str
    duration: str
    class_name: str = Field(alias="class")
    confidence: float

    model_config = {"populate_by_name": True}


# ── Models (registry) ───────────────────────────────────────────────────────

class ModelRegisterRequest(BaseModel):
    """Manually register a model that was trained elsewhere (e.g. Teachable
    Machine) and already uploaded to Cloud Storage as a raw .h5 file."""
    name: str
    model_storage_path: str
    labels: List[str]
    metrics: Optional[Dict] = None
    dataset_version: Optional[str] = None
    # OCR text-fusion extras (all optional — a model works fine as CNN-only
    # without them; see app/ml/hybrid_classifier.py):
    text_model_storage_path: Optional[str] = None
    fusion_alpha: Optional[float] = None
    # Per-class override of fusion_alpha (class_name -> alpha, 1.0 meaning
    # "CNN-only for this class") — see
    # training_pipeline.py::_compute_per_class_alpha for how this gets
    # computed automatically during in-app training.
    fusion_alpha_per_class: Optional[Dict[str, float]] = None
    keyword_rules: Optional[Dict[str, List[str]]] = None


class ModelOut(BaseModel):
    model_id: str
    name: str
    labels: List[str]
    model_storage_path: str
    metrics: Optional[Dict] = None
    dataset_version: Optional[str] = None
    is_active: bool = False
    created_at: Optional[str] = None
    text_model_storage_path: Optional[str] = None
    fusion_alpha: Optional[float] = None
    fusion_alpha_per_class: Optional[Dict[str, float]] = None
    keyword_rules: Optional[Dict[str, List[str]]] = None


class KeywordRulesUpdateRequest(BaseModel):
    """class_name -> list of keywords/phrases (fuzzy-matched against OCR'd
    frame text). See app/ml/text_rules.py. Editable without retraining."""
    keyword_rules: Dict[str, List[str]]


class ModelRenameRequest(BaseModel):
    name: str


# ── Training ─────────────────────────────────────────────────────────────

class SplitRatios(BaseModel):
    train: float = 0.7
    val: float = 0.15
    test: float = 0.15


class TrainingImageRef(BaseModel):
    """One training image, already uploaded directly to Cloud Storage by the
    caller via a signed URL (same pattern as video jobs). The
    training pipeline deletes every training image once training SUCCEEDS —
    these are just as temporary as videos, not a permanent dataset store. A
    failed run keeps its images so POST /train/{id}/retry can reuse them."""
    storage_path: str


class TrainRequest(BaseModel):
    model_name: str
    # class_name -> list of training images for that class
    dataset: Dict[str, List[TrainingImageRef]]
    split: SplitRatios = SplitRatios()
    # All four below are "advanced" options on the frontend — sensible
    # defaults if the caller (or the UI's collapsed Advanced panel) doesn't
    # touch them. Bounded with Field(...) as a defensive server-side check,
    # since the frontend's own input min/max is just a UI nicety a client
    # could bypass entirely.
    epochs: int = Field(default=20, ge=1, le=500)
    batch_size: int = Field(default=16, ge=1, le=256)
    learning_rate: float = Field(default=0.001, gt=0, le=1)
    # Optional keyword-rule override, baked into the resulting model doc at
    # creation time (also editable later via PATCH /models/{id}/keyword-rules
    # without retraining). The OCR text classifier itself is always trained
    # automatically alongside the CNN when there's enough usable text.
    keyword_rules: Optional[Dict[str, List[str]]] = None


class TrainProgress(BaseModel):
    """Live status of an in-flight training run, written by
    training_pipeline.py as it moves through stages so the frontend can show
    something better than a spinner. `epoch`/`epochs`/`accuracy`/`loss`/
    `val_accuracy` are only populated during the `training_cnn` stage."""
    stage: str  # starting | downloading | training_cnn | evaluating_cnn | extracting_text | tuning_fusion | saving_model
    detail: Optional[str] = None
    epoch: Optional[int] = None
    epochs: Optional[int] = None
    accuracy: Optional[float] = None
    loss: Optional[float] = None
    val_accuracy: Optional[float] = None


class TrainJobOut(BaseModel):
    training_job_id: str
    status: str  # queued | processing | done | failed
    model_name: str
    model_id: Optional[str] = None
    metrics: Optional[Dict] = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    class_names: Optional[List[str]] = None  # dataset's class names, for a nicer job-list label
    progress: Optional[TrainProgress] = None
    retry_count: int = 0  # incremented by POST /train/{id}/retry, which reuses this same doc/id
    # The hyperparameters this run actually used — surfaced mainly so the
    # training-job history can show what produced a given result. None on
    # jobs created before these fields existed.
    epochs: Optional[int] = None
    batch_size: Optional[int] = None
    learning_rate: Optional[float] = None
    split: Optional[SplitRatios] = None


# ── Analytics (SPM / DSM) ───────────────────────────────────────────────────

class SPMRequest(BaseModel):
    job_ids: List[str]
    min_support: float = 0.3  # fraction of sequences a pattern must appear in
    top_k: int = 10


class SPMPattern(BaseModel):
    pattern: List[str]
    support: int
    support_fraction: float


class DSMRequest(BaseModel):
    group_a_job_ids: List[str]
    group_b_job_ids: List[str]
    min_support: float = 0.2
    top_k: int = 10


class DSMPattern(BaseModel):
    pattern: List[str]
    support_a: float
    support_b: float
    diff: float  # support_a - support_b; positive => more typical of group A
