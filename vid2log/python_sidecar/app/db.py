"""
Local SQLite storage for job metadata + results — the offline-desktop
replacement for the cloud backend's Firestore `jobs` collection. One file,
one table, no server process, which is the whole point: this is meant to be
opened fresh (a new connection per call) from whatever thread needs it,
since sqlite3 connections aren't safe to share across threads — the
background job runner (app/video_pipeline.py) and the FastAPI request
handlers (app/main.py) always call `get_connection()` themselves rather than
sharing one.

`scenes_json` stores the scene-log rows as a JSON blob rather than a second
table — there's exactly one owner (the job that produced them), no querying
into individual scenes is ever needed, and it mirrors how the cloud
backend's Firestore job doc already just embeds a `scenes` array directly.
"""
import json
import sqlite3
from pathlib import Path
from typing import Any, Optional

from app.config import DB_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,                  -- queued | processing | done | failed
    video_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    display_name TEXT,
    model_id TEXT,                         -- NULL = resolve active, else bundled default
    fps INTEGER NOT NULL DEFAULT 2,
    scene_count INTEGER,
    scenes_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
);

-- The local Model Registry — the offline counterpart of the cloud
-- backend's Firestore `models` collection. Only METADATA lives here; the
-- actual weights sit on disk under MODELS_DIR/{model_id}/ (see
-- app/config.py and app/ml/classifier.py, which reads that layout).
CREATE TABLE IF NOT EXISTS models (
    model_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    labels_json TEXT NOT NULL,
    fusion_alpha REAL,
    fusion_alpha_per_class_json TEXT,
    metrics_json TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    dataset_version TEXT,                  -- the training_job_id that produced it
    created_at TEXT NOT NULL
);

-- "Create actions": one row per discovery run over a demo video.
CREATE TABLE IF NOT EXISTS discovery_jobs (
    discovery_job_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,                  -- queued | processing | done | failed
    video_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    fps INTEGER NOT NULL DEFAULT 2,
    min_cluster_size INTEGER NOT NULL DEFAULT 5,
    clusters_json TEXT,                    -- proposed clusters once done
    progress_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
);

-- A reviewed discovery run, saved as a reusable dataset. Only metadata
-- lives here; the images sit under ACTION_DATASETS_DIR/{dataset_id}/ in
-- subfolder-per-action layout (see app/config.py).
CREATE TABLE IF NOT EXISTS action_datasets (
    dataset_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    action_counts_json TEXT NOT NULL,      -- {action name: image count}
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS training_jobs (
    training_job_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,                  -- queued | processing | done | failed
    model_name TEXT NOT NULL,
    -- {action_name: [absolute image paths]}. Unlike the cloud version there's
    -- no upload and no copy: these point at the user's own files, in place.
    dataset_json TEXT NOT NULL,
    epochs INTEGER NOT NULL DEFAULT 20,
    batch_size INTEGER NOT NULL DEFAULT 16,
    learning_rate REAL NOT NULL DEFAULT 0.001,
    split_json TEXT NOT NULL,
    progress_json TEXT,
    model_id TEXT,                         -- set once the run succeeds
    metrics_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
);
"""

# Columns holding a JSON blob, per table — `_row_to_dict` decodes each of
# these into a real Python object and drops the `_json` suffix, so callers
# deal in dicts/lists and never in encoded strings.
_JSON_COLUMNS = {
    "jobs": {"scenes_json": "scenes"},
    "models": {
        "labels_json": "labels",
        "fusion_alpha_per_class_json": "fusion_alpha_per_class",
        "metrics_json": "metrics",
    },
    "training_jobs": {
        "dataset_json": "dataset",
        "split_json": "split",
        "progress_json": "progress",
        "metrics_json": "metrics",
    },
    "discovery_jobs": {
        "clusters_json": "clusters",
        "progress_json": "progress",
    },
    "action_datasets": {
        "action_counts_json": "action_counts",
    },
}


def get_connection(db_path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: Path = DB_PATH) -> None:
    conn = get_connection(db_path)
    try:
        conn.executescript(_SCHEMA)
        conn.commit()
    finally:
        conn.close()


def _row_to_dict(row: sqlite3.Row, table: str) -> dict:
    d = dict(row)
    for json_col, plain_col in _JSON_COLUMNS[table].items():
        raw = d.pop(json_col, None)
        d[plain_col] = json.loads(raw) if raw else None
    return d


def _row_to_job_dict(row: sqlite3.Row) -> dict:
    return _row_to_dict(row, "jobs")


def _encode_json_fields(fields: dict[str, Any], table: str) -> dict[str, Any]:
    """Inverse of _row_to_dict for writes — callers pass `scenes`/`labels`/
    `metrics`/etc. as real objects and this encodes them into their `_json`
    columns, so no caller ever hand-rolls a json.dumps()."""
    fields = dict(fields)
    for json_col, plain_col in _JSON_COLUMNS[table].items():
        if plain_col in fields:
            value = fields.pop(plain_col)
            fields[json_col] = json.dumps(value) if value is not None else None
    return fields


def insert_job(job: dict) -> None:
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO jobs (job_id, status, video_path, original_filename, display_name,
                               model_id, fps, created_at)
            VALUES (:job_id, :status, :video_path, :original_filename, :display_name,
                    :model_id, :fps, :created_at)
            """,
            job,
        )
        conn.commit()
    finally:
        conn.close()


def update_job(job_id: str, fields: dict[str, Any]) -> None:
    """`fields` may include `scenes` (a list) — translated to `scenes_json`
    automatically so callers never have to think about the JSON encoding."""
    fields = _encode_json_fields(fields, "jobs")

    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    conn = get_connection()
    try:
        conn.execute(f"UPDATE jobs SET {set_clause} WHERE job_id = :job_id", {**fields, "job_id": job_id})
        conn.commit()
    finally:
        conn.close()


def get_job(job_id: str) -> Optional[dict]:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM jobs WHERE job_id = ?", (job_id,)).fetchone()
        return _row_to_job_dict(row) if row else None
    finally:
        conn.close()


def list_jobs(limit: int = 50) -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [_row_to_job_dict(r) for r in rows]
    finally:
        conn.close()


def delete_job(job_id: str) -> bool:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM jobs WHERE job_id = ?", (job_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── Model registry ────────────────────────────────────────────────────────


def insert_model(model: dict) -> None:
    row = _encode_json_fields(model, "models")
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO models (model_id, name, labels_json, fusion_alpha,
                                fusion_alpha_per_class_json, metrics_json,
                                is_active, dataset_version, created_at)
            VALUES (:model_id, :name, :labels_json, :fusion_alpha,
                    :fusion_alpha_per_class_json, :metrics_json,
                    :is_active, :dataset_version, :created_at)
            """,
            row,
        )
        conn.commit()
    finally:
        conn.close()


def get_model(model_id: str) -> Optional[dict]:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM models WHERE model_id = ?", (model_id,)).fetchone()
        return _row_to_dict(row, "models") if row else None
    finally:
        conn.close()


def list_models() -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM models ORDER BY created_at DESC").fetchall()
        return [_row_to_dict(r, "models") for r in rows]
    finally:
        conn.close()


def get_active_model() -> Optional[dict]:
    conn = get_connection()
    try:
        row = conn.execute("SELECT * FROM models WHERE is_active = 1 LIMIT 1").fetchone()
        return _row_to_dict(row, "models") if row else None
    finally:
        conn.close()


def set_active_model(model_id: str) -> None:
    """Exactly one model is active at a time — both statements run in one
    transaction so there's never a moment where zero (or two) are flagged."""
    conn = get_connection()
    try:
        conn.execute("UPDATE models SET is_active = 0 WHERE is_active = 1")
        conn.execute("UPDATE models SET is_active = 1 WHERE model_id = ?", (model_id,))
        conn.commit()
    finally:
        conn.close()


def update_model(model_id: str, fields: dict[str, Any]) -> None:
    fields = _encode_json_fields(fields, "models")
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    conn = get_connection()
    try:
        conn.execute(
            f"UPDATE models SET {set_clause} WHERE model_id = :model_id",
            {**fields, "model_id": model_id},
        )
        conn.commit()
    finally:
        conn.close()


def delete_model(model_id: str) -> bool:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM models WHERE model_id = ?", (model_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── Training jobs ─────────────────────────────────────────────────────────


def insert_training_job(job: dict) -> None:
    row = _encode_json_fields(job, "training_jobs")
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO training_jobs (training_job_id, status, model_name, dataset_json,
                                       epochs, batch_size, learning_rate, split_json,
                                       created_at)
            VALUES (:training_job_id, :status, :model_name, :dataset_json,
                    :epochs, :batch_size, :learning_rate, :split_json,
                    :created_at)
            """,
            row,
        )
        conn.commit()
    finally:
        conn.close()


def update_training_job(training_job_id: str, fields: dict[str, Any]) -> None:
    fields = _encode_json_fields(fields, "training_jobs")
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    conn = get_connection()
    try:
        conn.execute(
            f"UPDATE training_jobs SET {set_clause} WHERE training_job_id = :training_job_id",
            {**fields, "training_job_id": training_job_id},
        )
        conn.commit()
    finally:
        conn.close()


def get_training_job(training_job_id: str) -> Optional[dict]:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM training_jobs WHERE training_job_id = ?", (training_job_id,)
        ).fetchone()
        return _row_to_dict(row, "training_jobs") if row else None
    finally:
        conn.close()


def list_training_jobs(limit: int = 50) -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM training_jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [_row_to_dict(r, "training_jobs") for r in rows]
    finally:
        conn.close()


def delete_training_job(training_job_id: str) -> bool:
    conn = get_connection()
    try:
        cur = conn.execute(
            "DELETE FROM training_jobs WHERE training_job_id = ?", (training_job_id,)
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ── Action discovery ──────────────────────────────────────────────────────


def insert_discovery_job(job: dict) -> None:
    row = _encode_json_fields(job, "discovery_jobs")
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO discovery_jobs (discovery_job_id, status, video_path, original_filename,
                                        fps, min_cluster_size, created_at)
            VALUES (:discovery_job_id, :status, :video_path, :original_filename,
                    :fps, :min_cluster_size, :created_at)
            """,
            row,
        )
        conn.commit()
    finally:
        conn.close()


def update_discovery_job(discovery_job_id: str, fields: dict[str, Any]) -> None:
    fields = _encode_json_fields(fields, "discovery_jobs")
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    conn = get_connection()
    try:
        conn.execute(
            f"UPDATE discovery_jobs SET {set_clause} WHERE discovery_job_id = :discovery_job_id",
            {**fields, "discovery_job_id": discovery_job_id},
        )
        conn.commit()
    finally:
        conn.close()


def get_discovery_job(discovery_job_id: str) -> Optional[dict]:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM discovery_jobs WHERE discovery_job_id = ?", (discovery_job_id,)
        ).fetchone()
        return _row_to_dict(row, "discovery_jobs") if row else None
    finally:
        conn.close()


def list_discovery_jobs(limit: int = 50) -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute(
            "SELECT * FROM discovery_jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
        return [_row_to_dict(r, "discovery_jobs") for r in rows]
    finally:
        conn.close()


def delete_discovery_job(discovery_job_id: str) -> bool:
    conn = get_connection()
    try:
        cur = conn.execute(
            "DELETE FROM discovery_jobs WHERE discovery_job_id = ?", (discovery_job_id,)
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def insert_action_dataset(dataset: dict) -> None:
    row = _encode_json_fields(dataset, "action_datasets")
    conn = get_connection()
    try:
        conn.execute(
            """
            INSERT INTO action_datasets (dataset_id, name, action_counts_json, created_at)
            VALUES (:dataset_id, :name, :action_counts_json, :created_at)
            """,
            row,
        )
        conn.commit()
    finally:
        conn.close()


def update_action_dataset(dataset_id: str, fields: dict[str, Any]) -> None:
    fields = _encode_json_fields(fields, "action_datasets")
    set_clause = ", ".join(f"{k} = :{k}" for k in fields)
    conn = get_connection()
    try:
        conn.execute(
            f"UPDATE action_datasets SET {set_clause} WHERE dataset_id = :dataset_id",
            {**fields, "dataset_id": dataset_id},
        )
        conn.commit()
    finally:
        conn.close()


def get_action_dataset(dataset_id: str) -> Optional[dict]:
    conn = get_connection()
    try:
        row = conn.execute(
            "SELECT * FROM action_datasets WHERE dataset_id = ?", (dataset_id,)
        ).fetchone()
        return _row_to_dict(row, "action_datasets") if row else None
    finally:
        conn.close()


def list_action_datasets() -> list[dict]:
    conn = get_connection()
    try:
        rows = conn.execute("SELECT * FROM action_datasets ORDER BY created_at DESC").fetchall()
        return [_row_to_dict(r, "action_datasets") for r in rows]
    finally:
        conn.close()


def delete_action_dataset(dataset_id: str) -> bool:
    conn = get_connection()
    try:
        cur = conn.execute("DELETE FROM action_datasets WHERE dataset_id = ?", (dataset_id,))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()
