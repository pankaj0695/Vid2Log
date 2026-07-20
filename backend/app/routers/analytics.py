"""
Sequential Pattern Mining (SPM) and Differential Sequence Mining (DSM) over
the scene logs already stored in Firestore. Each processed video's scenes
become one ordered sequence of activity labels (e.g.
["ProblemStatement", "GameWorkspace", "ProductSelection", ...]); a PrefixSpan-
style algorithm mines frequent sub-sequences across many such sequences.
"""
import math
from typing import List

from fastapi import APIRouter, Depends, HTTPException

from app.schemas import DSMPattern, DSMRequest, SPMPattern, SPMRequest
from app.services.firebase_service import get_current_user, get_db
from app.services.sequence_mining import frequent_patterns as _mine_patterns

router = APIRouter(prefix="/analytics", tags=["analytics"])


def _job_sequence(db, job_id: str, user: dict) -> List[str]:
    doc = db.collection("jobs").document(job_id).get()
    if not doc.exists:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    data = doc.to_dict()
    if data.get("owner_uid") != user["uid"]:
        raise HTTPException(status_code=403, detail=f"Not your job: {job_id}")
    if data.get("status") != "done":
        raise HTTPException(status_code=409, detail=f"Job {job_id} not done yet")
    # scenes are already in chronological order (start_time ascending)
    return [row["class"] for row in data.get("scenes", [])]


# Hard cap on how long a mined pattern is allowed to get. Without this, a
# handful of videos whose scenes flicker back and forth between a small set
# of classes (very common — a frame-by-frame classifier naturally produces
# many short scenes) gives PrefixSpan an exponential number of "frequent"
# sub-sequences to enumerate once support filtering stops pruning much (see
# the min_support_count comment below) — in practice this looked like the
# request hanging forever with no error, not a crash. A pattern of even 8
# steps is already far more than anyone reads as one "workflow," so this
# caps runaway recursion without losing anything useful.
MAX_PATTERN_LEN = 8


def _frequent_patterns(sequences: List[List[str]], min_support_fraction: float, top_k: int):
    if not sequences:
        return []
    # ceil, not int()/floor: with int(), a fraction*count that lands between
    # 0 and 1 (e.g. 0.3 * 5 videos = 1.5 -> int() truncates to 1) silently
    # produces a minimum support of "appears in at least 1 video" — which is
    # every pattern that exists at all, i.e. no filtering. That combined with
    # PrefixSpan's recursive projection is what turned a handful of selected
    # videos into a practically-unbounded search (the "Run SPM" hang). ceil()
    # makes "0.3 of 5 videos" mean "at least 2", matching what a user reading
    # "30% of videos" actually expects.
    min_support_count = max(1, math.ceil(min_support_fraction * len(sequences)))
    # min_len=2: single-item "patterns" aren't very informative here
    results = _mine_patterns(sequences, min_support_count, min_len=2, max_len=MAX_PATTERN_LEN)
    results.sort(key=lambda r: r[0], reverse=True)
    return results[:top_k]


@router.post("/spm", response_model=list[SPMPattern])
def sequential_pattern_mining(payload: SPMRequest, user: dict = Depends(get_current_user)):
    """Frequent activity sub-sequences across the given set of videos —
    surfaces common workflows, loops, and rework patterns."""
    db = get_db()
    sequences = [_job_sequence(db, jid, user) for jid in payload.job_ids]
    results = _frequent_patterns(sequences, payload.min_support, payload.top_k)
    n = len(sequences)
    return [
        SPMPattern(pattern=pattern, support=support, support_fraction=support / n if n else 0)
        for support, pattern in results
    ]


@router.post("/dsm", response_model=list[DSMPattern])
def differential_sequence_mining(payload: DSMRequest, user: dict = Depends(get_current_user)):
    """
    Compares patterns between two groups of videos (e.g. high- vs.
    low-performing sessions) and ranks patterns by how differently often they
    occur in one group vs. the other — the "what actually differs" answer.
    """
    db = get_db()
    seqs_a = [_job_sequence(db, jid, user) for jid in payload.group_a_job_ids]
    seqs_b = [_job_sequence(db, jid, user) for jid in payload.group_b_job_ids]

    if not seqs_a or not seqs_b:
        raise HTTPException(status_code=400, detail="Both groups need at least one job.")

    # Mine each group independently, then compare support across the union
    # of patterns found in either group.
    patterns_a = {tuple(p): s / len(seqs_a) for s, p in _frequent_patterns(seqs_a, payload.min_support, 10_000)}
    patterns_b = {tuple(p): s / len(seqs_b) for s, p in _frequent_patterns(seqs_b, payload.min_support, 10_000)}

    all_patterns = set(patterns_a) | set(patterns_b)
    diffs = []
    for pattern in all_patterns:
        support_a = patterns_a.get(pattern, 0.0)
        support_b = patterns_b.get(pattern, 0.0)
        diffs.append(
            DSMPattern(pattern=list(pattern), support_a=support_a, support_b=support_b, diff=support_a - support_b)
        )

    diffs.sort(key=lambda d: abs(d.diff), reverse=True)
    return diffs[: payload.top_k]
