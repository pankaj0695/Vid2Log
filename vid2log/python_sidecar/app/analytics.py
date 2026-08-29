"""
Sequential Pattern Mining (SPM) and Differential Sequence Mining (DSM) over
the scene logs in the local SQLite database — the offline-desktop port of
backend/app/routers/analytics.py.

Each processed video's scenes become one ordered sequence of activity labels
(e.g. ["ProblemStatement", "GameWorkspace", "ProductSelection", ...]); a
PrefixSpan-style algorithm (app/sequence_mining.py) mines frequent
sub-sequences across many such sequences.

The analysis itself is identical to the cloud version — same mining engine,
same support definitions, same scipy tests — because it's pure computation
over data that's already local. Only where the sequences are read from
changed: SQLite instead of Firestore, and no owner/auth checks, since there
is exactly one user.

scipy is only imported inside the DSM path. It arrives as a scikit-learn
dependency rather than a direct one, and SPM has no use for it — so an SPM
run stays fast and doesn't pay for loading it.
"""
import logging
import math
import statistics
from typing import List, Optional

from fastapi import HTTPException

from app.db import get_job
from app.sequence_mining import count_instances as _count_instances
from app.sequence_mining import frequent_patterns as _mine_patterns

log = logging.getLogger(__name__)

# Hard cap on how long a mined pattern is allowed to get. Without this, a
# handful of videos whose scenes flicker back and forth between a small set
# of actions (very common — a frame-by-frame classifier naturally produces
# many short scenes) gives PrefixSpan an exponential number of "frequent"
# sub-sequences to enumerate once support filtering stops pruning much. In
# practice that looked like the request hanging forever rather than failing.
# A pattern of even 8 steps is already far more than anyone reads as one
# "workflow", so this caps runaway recursion without losing anything useful.
MAX_PATTERN_LEN = 8

# Every scipy.stats two-independent-samples test exposed as a "Test type"
# choice — a straight pass-through to scipy, one function per name
# (poisson_means_test is the odd one out, called with counts rather than raw
# samples; see _two_sample_p_value). We don't editorialize about which test
# is "right" for a given comparison (some, like ansari/mood, test dispersion
# rather than location) — the choice is the caller's to make.
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


def job_sequence(job_id: str) -> List[str]:
    """One video's chronological action labels. Scene rows are already
    stored in start_time order (see app/video_pipeline.py), so no re-sorting
    is needed."""
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Log {job_id} not found")
    if job["status"] != "done":
        raise HTTPException(status_code=409, detail=f"Log {job_id} isn't finished yet")
    return [row["action"] for row in (job.get("scenes") or [])]


def _own_frequent_patterns(
    sequences: List[List[str]],
    s_support_threshold: float,
    i_support_threshold: float,
    window_min: int,
    window_max: int,
    min_gap: int,
    max_gap: Optional[int],
) -> List[List[str]]:
    """Patterns frequent WITHIN this one group of sequences — S-support over
    min_support_count of its own videos, AND I-support (mean instances per
    video, zeros included) at least i_support_threshold. Shared by SPM and
    DSM (DSM calls it once per group, see dsm_analyze)."""
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


def spm_analyze(
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
    """Gap/window-constrained mining for S-support, plus a per-pattern
    I-support pass (mean/sd of non-overlapping instance counts across all
    sequences, zeros included — see sequence_mining.py's docstring for why
    zeros are counted)."""
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
                "support": s_frequency,
                "support_fraction": s_frequency / n,
                "i_frequency": i_frequency,
                "i_support_mean": i_support_mean,
                "i_support_sd": i_support_sd,
            }
        )

    sort_key = (lambda r: r["i_support_mean"]) if sort_by == "i_support" else (lambda r: r["support_fraction"])
    enriched.sort(key=sort_key, reverse=True)
    return enriched[:top_k]


def _two_sample_p_value(test_type: str, counts_a: List[int], counts_b: List[int]) -> Optional[float]:
    """Runs the selected two-independent-samples test on a pattern's
    per-video instance (I-support) counts from each group. Returns None when
    the test can't be computed for this pair of samples (too few
    observations, degenerate/constant data for a scale test, etc.) — such
    patterns are dropped rather than surfaced with a bogus p-value."""
    from scipy import stats as scipy_stats

    try:
        if test_type == "poisson_means_test":
            # This test compares two Poisson RATES (k events per n exposure
            # units), not two raw samples — k/n here is total occurrences
            # over total videos in each group, i.e. exactly the I-support
            # mean the rest of this module reports.
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


def dsm_analyze(
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
    """Mines each group's OWN frequent patterns (using the same
    gap/window-constrained engine as SPM), then for every such pattern runs a
    two-sample significance test comparing its per-video I-support between
    group A ("left") and group B ("right") across ALL videos in both groups.
    Only patterns whose p-value clears `threshold_p_value` are kept — this is
    the "what's actually, statistically different" answer, not just "what
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
    # concatenates two independently-generated per-group tables.
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
