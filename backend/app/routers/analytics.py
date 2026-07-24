"""
Sequential Pattern Mining (SPM) and Differential Sequence Mining (DSM) over
the scene logs already stored in Firestore. Each processed video's scenes
become one ordered sequence of activity labels (e.g.
["ProblemStatement", "GameWorkspace", "ProductSelection", ...]); a PrefixSpan-
style algorithm mines frequent sub-sequences across many such sequences.
"""
import math
import statistics
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from scipy import stats as scipy_stats

from app.schemas import DSMPattern, DSMRequest, SPMPattern, SPMRequest
from app.services.firebase_service import get_current_user, get_db
from app.services.sequence_mining import count_instances as _count_instances
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


def _own_frequent_patterns(
    sequences: List[List[str]],
    s_support_threshold: float,
    i_support_threshold: float,
    window_min: int,
    window_max: int,
    min_gap: int,
    max_gap: Optional[int],
) -> List[List[str]]:
    """Patterns that are frequent WITHIN this one group of sequences — S-support
    over min_support_count of its own videos, AND I-support (mean instances
    per video, zeros included) at least i_support_threshold. Shared by SPM
    and DSM (DSM calls this once per group, see _dsm_analyze)."""
    n = len(sequences)
    if not n:
        return []
    min_support_count = max(1, math.ceil(s_support_threshold * n))
    raw = _mine_patterns(
        sequences, min_support_count, min_len=window_min, max_len=window_max, min_gap=min_gap, max_gap=max_gap
    )
    patterns = []
    for _s_frequency, pattern in raw:
        counts = [_count_instances(seq, pattern, min_gap, max_gap) for seq in sequences]
        if (sum(counts) / n) < i_support_threshold:
            continue
        patterns.append(pattern)
    return patterns


def _spm_analyze(
    sequences: List[List[str]],
    s_support_threshold: float,
    i_support_threshold: float,
    sliding_window_min: int,
    sliding_window_max: int,
    min_gap: int,
    max_gap: Optional[int],
    sort_by: str,
    top_k: int,
) -> List[dict]:
    """The full "Advanced options" SPM analysis: gap/window-constrained
    mining for S-support, plus a per-pattern I-support pass (mean/sd of
    non-overlapping instance counts across all sequences, zeros included —
    see sequence_mining.py's docstring for why)."""
    n = len(sequences)
    if not n:
        return []

    window_min = max(1, sliding_window_min)
    window_max = min(max(window_min, sliding_window_max), MAX_PATTERN_LEN)
    min_support_count = max(1, math.ceil(s_support_threshold * n))

    raw = _mine_patterns(
        sequences,
        min_support_count,
        min_len=window_min,
        max_len=window_max,
        min_gap=min_gap,
        max_gap=max_gap,
    )

    enriched = []
    for s_frequency, pattern in raw:
        counts = [_count_instances(seq, pattern, min_gap, max_gap) for seq in sequences]
        i_frequency = sum(counts)
        i_support_mean = i_frequency / n
        if i_support_mean < i_support_threshold:
            continue
        i_support_sd = statistics.pstdev(counts) if n > 1 else 0.0
        enriched.append(
            {
                "pattern": pattern,
                "s_frequency": s_frequency,
                "s_support": s_frequency / n,
                "i_frequency": i_frequency,
                "i_support_mean": i_support_mean,
                "i_support_sd": i_support_sd,
            }
        )

    sort_key = (lambda r: r["i_support_mean"]) if sort_by == "i_support" else (lambda r: r["s_support"])
    enriched.sort(key=sort_key, reverse=True)
    return enriched[:top_k]


@router.post("/spm", response_model=list[SPMPattern])
def sequential_pattern_mining(payload: SPMRequest, user: dict = Depends(get_current_user)):
    """Frequent activity sub-sequences across the given set of videos —
    surfaces common workflows, loops, and rework patterns. Reports both
    S-support (# of videos containing the pattern) and I-support (average #
    of times the pattern occurs per video), with optional gap/window
    constraints — see _spm_analyze()."""
    db = get_db()
    sequences = [_job_sequence(db, jid, user) for jid in payload.job_ids]
    results = _spm_analyze(
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
    return [
        SPMPattern(
            pattern=r["pattern"],
            support=r["s_frequency"],
            support_fraction=r["s_support"],
            i_frequency=r["i_frequency"],
            i_support_mean=r["i_support_mean"],
            i_support_sd=r["i_support_sd"],
        )
        for r in results
    ]


# Every scipy.stats two-independent-samples test exposed as a "Test Type"
# choice — this is a straight pass-through to scipy, one function per name
# (poisson_means_test is the odd one out, called with counts rather than raw
# samples; see _two_sample_p_value). We don't editorialize about which test
# is "right" for a given comparison (some, like ansari/mood, test dispersion
# rather than location) — this mirrors the reference tool's own dropdown
# verbatim, so the choice of test is the caller's to make.
TEST_TYPES = {
    "ttest_ind",
    "poisson_means_test",
    "mannwhitneyu",
    "bws_test",
    "ranksums",
    "brunnermunzel",
    "mood",
    "ansari",
    "cramervonmises_2samp",
    "epps_singleton_2samp",
    "ks_2samp",
    "kstest",
}


def _two_sample_p_value(test_type: str, counts_a: List[int], counts_b: List[int]) -> Optional[float]:
    """Runs the selected two-independent-samples test on a pattern's
    per-video instance (I-support) counts from each group. Returns None if
    the test can't be computed for this pair of samples (too few
    observations, degenerate/constant data for a scale test, etc.) — such
    patterns are simply dropped rather than surfaced with a bogus p-value."""
    try:
        if test_type == "poisson_means_test":
            # This test compares two Poisson RATES (k events per n exposure
            # units), not two raw samples — k/n here is total occurrences
            # over total videos in each group, i.e. exactly the I-support
            # mean the rest of this endpoint reports.
            k1, n1 = sum(counts_a), len(counts_a)
            k2, n2 = sum(counts_b), len(counts_b)
            if n1 == 0 or n2 == 0:
                return None
            result = scipy_stats.poisson_means_test(k1, n1, k2, n2)
        else:
            fn = getattr(scipy_stats, test_type)
            result = fn(counts_a, counts_b)
        p_value = float(result.pvalue)
        return p_value if math.isfinite(p_value) else None
    except Exception:
        return None


def _dsm_analyze(
    sequences_a: List[List[str]],
    sequences_b: List[List[str]],
    s_support_threshold: float,
    i_support_threshold: float,
    sliding_window_min: int,
    sliding_window_max: int,
    min_gap: int,
    max_gap: Optional[int],
    test_type: str,
    threshold_p_value: float,
    top_k: int,
) -> List[dict]:
    """Mines each group's OWN frequent patterns (S-support/I-support within
    that group alone, using the same gap/window-constrained engine as SPM),
    then for every such pattern runs a two-sample significance test
    comparing its per-video I-support between group A ("left") and group B
    ("right") across ALL videos in both groups (not just the home group's).
    Only patterns whose p-value clears `threshold_p_value` are kept — this
    is the "what's actually, statistically different" answer, not just "what
    differs in raw support"."""
    n_a, n_b = len(sequences_a), len(sequences_b)
    if not n_a or not n_b:
        return []

    window_min = max(1, sliding_window_min)
    window_max = min(max(window_min, sliding_window_max), MAX_PATTERN_LEN)

    home_a = _own_frequent_patterns(
        sequences_a, s_support_threshold, i_support_threshold, window_min, window_max, min_gap, max_gap
    )
    home_b = _own_frequent_patterns(
        sequences_b, s_support_threshold, i_support_threshold, window_min, window_max, min_gap, max_gap
    )

    def _row(pattern: List[str], home_group: str) -> Optional[dict]:
        counts_a = [_count_instances(seq, pattern, min_gap, max_gap) for seq in sequences_a]
        counts_b = [_count_instances(seq, pattern, min_gap, max_gap) for seq in sequences_b]
        p_value = _two_sample_p_value(test_type, counts_a, counts_b)
        if p_value is None or p_value > threshold_p_value:
            return None
        return {
            "pattern": pattern,
            "p_value": p_value,
            "isupport_left_mean": (sum(counts_a) / n_a) if home_group == "left" else None,
            "isupport_right_mean": (sum(counts_b) / n_b) if home_group == "right" else None,
            "group": home_group,
        }

    rows = []
    # A pattern frequent in BOTH groups produces two rows (one per home
    # group, each showing that group's own mean) — matching a design that
    # concatenates two independently-generated per-group tables, which is
    # what the blank-column pattern in the reference export implies.
    for pattern in home_a:
        row = _row(pattern, "left")
        if row:
            rows.append(row)
    for pattern in home_b:
        row = _row(pattern, "right")
        if row:
            rows.append(row)

    rows.sort(key=lambda r: r["p_value"])
    return rows[:top_k]


@router.post("/dsm", response_model=list[DSMPattern])
def differential_sequence_mining(payload: DSMRequest, user: dict = Depends(get_current_user)):
    """
    Compares patterns between two groups of videos (e.g. high- vs.
    low-performing sessions): mines each group's own frequent patterns, then
    runs a configurable statistical test on each pattern's per-video I-support
    between groups, keeping only the ones that clear the p-value threshold —
    the "what's actually, significantly different" answer, not just a raw
    support-fraction diff.
    """
    if payload.test_type not in TEST_TYPES:
        raise HTTPException(
            status_code=400, detail=f"Unknown test_type '{payload.test_type}'. Must be one of {sorted(TEST_TYPES)}."
        )

    db = get_db()
    seqs_a = [_job_sequence(db, jid, user) for jid in payload.group_a_job_ids]
    seqs_b = [_job_sequence(db, jid, user) for jid in payload.group_b_job_ids]

    if not seqs_a or not seqs_b:
        raise HTTPException(status_code=400, detail="Both groups need at least one job.")

    rows = _dsm_analyze(
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
    return [
        DSMPattern(
            pattern=r["pattern"],
            p_value=r["p_value"],
            isupport_left_mean=r["isupport_left_mean"],
            isupport_right_mean=r["isupport_right_mean"],
            group=r["group"],
        )
        for r in rows
    ]
