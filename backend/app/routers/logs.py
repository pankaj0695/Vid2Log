import csv
import io

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from app.services.firebase_service import get_current_user, get_db

router = APIRouter(prefix="/logs", tags=["logs"])


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
        fieldnames=["start_time", "end_time", "duration", "class", "confidence", "source"],
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
                fieldnames=["video_id", "start_time", "end_time", "duration", "class", "confidence", "source"],
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
