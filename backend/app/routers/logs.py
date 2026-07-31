import csv
import io
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.schemas import JobOut
from app.services.firebase_service import get_current_user, get_db

router = APIRouter(prefix="/logs", tags=["logs"])

# Columns a hand-built/externally-produced log CSV must have to be imported
# via POST /logs/import — matches get_log_csv's own export format exactly
# (minus `source`, which is optional there too) so a round-tripped
# export-then-reimport is always valid.
REQUIRED_IMPORT_COLUMNS = {"start_time", "end_time", "duration", "action", "confidence"}


def _get_owned_job(db, job_id: str, user: dict) -> dict:
    doc = db.collection("jobs").document(job_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail="Job not found")
    data = doc.to_dict()
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail="Not your job")
    if data.get("status") != "done":
        raise HTTPException(status_code=409, detail=f"Job is '{data.get('status')}', not ready yet.")
    return data


@router.get("/{job_id}")
def get_log(job_id: str, user: dict = Depends(get_current_user)):
    """Scene rows as JSON — used by the frontend's log-visualization view."""
    db = get_db()
    data = _get_owned_job(db, job_id, user)
    return {"job_id": job_id, "original_filename": data["original_filename"], "scenes": data.get("scenes", [])}


@router.get("/{job_id}/csv")
def get_log_csv(job_id: str, user: dict = Depends(get_current_user)):
    """Same content as the Streamlit app's downloadable CSV, generated
    on-the-fly from the Firestore-stored scene rows (no CSV file is kept in
    Cloud Storage — it's cheap to regenerate and Firestore is the source of truth)."""
    db = get_db()
    data = _get_owned_job(db, job_id, user)

    buffer = io.StringIO()
    # `source` records which tier decided the final label for that scene:
    # "cnn" (visual only), "keyword_rule", or "fusion" (CNN+OCR text) — see
    # app/ml/hybrid_classifier.py. extrasaction="ignore" keeps this forward
    # compatible if scene rows ever gain further debug fields.
    writer = csv.DictWriter(
        buffer,
        fieldnames=["start_time", "end_time", "duration", "action", "confidence", "source"],
        extrasaction="ignore",
    )
    writer.writeheader()
    for row in data.get("scenes", []):
        writer.writerow(row)
    buffer.seek(0)

    filename = f"{data['original_filename'].rsplit('.', 1)[0]}_analysis.csv"
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/import", response_model=JobOut)
async def import_csv_log(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    """Creates a 'done' job/log directly from an uploaded CSV of scene rows,
    for logs that already exist outside vid2log (produced by hand, exported
    from elsewhere, etc.) rather than coming from video processing. Skips the
    whole video pipeline entirely — no storage_path, no worker job, no
    classifier call; the CSV's rows become the scenes as-is, same shape as
    what get_log_csv above already exports, so export-then-reimport round-
    trips cleanly."""
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")  # -sig tolerates a BOM from Excel-exported CSVs
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded text.")

    reader = csv.DictReader(io.StringIO(text))
    present_columns = set(reader.fieldnames or [])
    missing_columns = sorted(REQUIRED_IMPORT_COLUMNS - present_columns)
    if reader.fieldnames is None or missing_columns:
        raise HTTPException(
            status_code=400,
            detail=(
                f"CSV is missing required column{'s' if len(missing_columns) != 1 else ''}: "
                f"{', '.join(missing_columns) or ', '.join(sorted(REQUIRED_IMPORT_COLUMNS))}. "
                "Download the template for the exact format."
            ),
        )

    scenes = []
    for i, row in enumerate(reader, start=2):  # start=2: row 1 is the header
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

    db = get_db()
    job_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc).isoformat()
    original_filename = file.filename or "imported_log.csv"

    doc = {
        "job_id": job_id,
        "status": "done",
        "owner_uid": user["uid"],
        "original_filename": original_filename,
        "resource_type": "csv_import",
        "scene_count": len(scenes),
        "scenes": scenes,
        "created_at": now,
        "started_at": now,
        "completed_at": now,
    }
    db.collection("jobs").document(job_id).set(doc)

    return JobOut(
        job_id=job_id,
        status="done",
        original_filename=original_filename,
        scene_count=len(scenes),
        created_at=now,
        started_at=now,
        completed_at=now,
    )


@router.post("/combine")
def combine_logs(job_ids: list[str], user: dict = Depends(get_current_user)):
    """Equivalent of the standalone combine_logs.py script, but over Firestore
    jobs instead of a folder of CSVs, exposed as one API call."""
    db = get_db()
    buffer = io.StringIO()
    writer = None

    for job_id in job_ids:
        data = _get_owned_job(db, job_id, user)
        if writer is None:
            writer = csv.DictWriter(
                buffer,
                fieldnames=["video_id", "start_time", "end_time", "duration", "action", "confidence", "source"],
                extrasaction="ignore",
            )
            writer.writeheader()
        for row in data.get("scenes", []):
            writer.writerow({"video_id": job_id, **row})

    buffer.seek(0)
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="combined_logs.csv"'},
    )
