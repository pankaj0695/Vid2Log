"""Pydantic request/response models for the vid2log API."""
from typing import Dict, List, Optional

from pydantic import BaseModel, Field


# ── Jobs (video processing) ─────────────────────────────────────────────────

class JobCreateRequest(BaseModel):
    """
    Sent by the frontend *after* it has already uploaded the video directly to
    Cloudinary via the unsigned upload preset. We never receive the raw video
    bytes here — only the reference Cloudinary handed back.
    """
    cloudinary_public_id: str
    cloudinary_url: str
    resource_type: str = "video"
    original_filename: str
    fps: int = 2
    model_id: Optional[str] = None  # None -> use the currently active model


class JobOut(BaseModel):
    job_id: str
    status: str  # queued | processing | done | failed | cancelled
    original_filename: str
    model_id: Optional[str] = None
    scene_count: Optional[int] = None
    error: Optional[str] = None
    created_at: Optional[str] = None
    started_at: Optional[str] = None
    completed_at: Optional[str] = None


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
    Machine) and already uploaded to Cloudinary as a raw .h5 file."""
    name: str
    cloudinary_url: str
    cloudinary_public_id: str
    labels: List[str]
    metrics: Optional[Dict] = None
    dataset_version: Optional[str] = None


class ModelOut(BaseModel):
    model_id: str
    name: str
    labels: List[str]
    cloudinary_url: str
    metrics: Optional[Dict] = None
    dataset_version: Optional[str] = None
    is_active: bool = False
    created_at: Optional[str] = None


# ── Training ─────────────────────────────────────────────────────────────

class SplitRatios(BaseModel):
    train: float = 0.7
    val: float = 0.15
    test: float = 0.15


class TrainRequest(BaseModel):
    model_name: str
    # class_name -> list of Cloudinary image URLs for that class
    dataset: Dict[str, List[str]]
    split: SplitRatios = SplitRatios()
    epochs: int = 10


class TrainJobOut(BaseModel):
    training_job_id: str
    status: str  # queued | processing | done | failed
    model_name: str
    model_id: Optional[str] = None
    metrics: Optional[Dict] = None
    error: Optional[str] = None


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
