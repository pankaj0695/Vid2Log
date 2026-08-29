"""Small shared helpers — trimmed copy of backend/app/utils.py's
format_timedelta (the only piece video_pipeline.py actually needs; the
Firestore-array-shape helpers don't apply here since there's no Firestore)."""
from datetime import timedelta


def format_timedelta(td_seconds: float) -> str:
    """HH:MM:SS formatting, identical to the cloud backend and the original
    Streamlit app so CSV output stays consistent across all three."""
    td = timedelta(seconds=td_seconds)
    total_seconds = int(td.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
