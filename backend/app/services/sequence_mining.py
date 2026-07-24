"""
A minimal, dependency-free Sequential Pattern Mining implementation
(PrefixSpan-style, with optional gap constraints) for single-symbol
sequences — each processed video's chronological list of activity-class
labels, e.g. ["ProblemStatement", "GameWorkspace", "ProductSelection", ...].

We hand-roll this instead of depending on the `prefixspan` PyPI package
because it pulls in `extratools`, an unmaintained package that hard-pins
ancient versions of common libraries (e.g. `Pillow==1.7.8`, from ~2010) —
which fails to build on modern Python/macOS (`use_2to3 is invalid`) and
breaks `pip install` entirely. The algorithm itself is short enough that it
isn't worth carrying that dependency risk.

This module reports BOTH of the two support notions used in the sequential
pattern mining literature (see e.g. Kinnebrew, Loretz & Biswas, 2013,
"Advancing Batch Learning to Skill Discovery in an Open Educational Learning
Environment", Journal of Educational Data Mining 5(1), which uses this exact
duality on a very similar activity-log domain):

- **S-support** ("sequence support"): the fraction/count of DISTINCT input
  sequences that contain the pattern as a (gap-constrained) subsequence at
  least once. This is the original PrefixSpan/Agrawal-Srikant support
  notion — `frequent_patterns()` below computes this.
- **I-support** ("instance support"): how many times the pattern occurs
  *within* a single sequence, counted via non-overlapping greedy matching
  (an event position can't be reused across two counted instances of the
  same pattern) — see `count_instances()` below. Averaged across all
  sequences (including sequences with zero occurrences), this is the
  I-support (mean)/I-support (sd) pair shown by research SPM tools.

`min_gap`/`max_gap` bound how many OTHER events are allowed to appear
between two CONSECUTIVE items of a pattern, in the style of constrained
sequential pattern mining (Srikant & Agrawal, 1996; the SPADE/cSPADE family,
Zaki, 2001 — exposed in R's `arulesSequences::cspade()` as `mingap`/
`maxgap`). The defaults (`min_gap=0`, `max_gap=None`) reproduce plain
PrefixSpan's "anywhere later in the sequence" matching.
"""
from typing import Dict, List, Optional, Tuple


def frequent_patterns(
    sequences: List[List[str]],
    min_support_count: int,
    min_len: int = 1,
    max_len: Optional[int] = None,
    min_gap: int = 0,
    max_gap: Optional[int] = None,
) -> List[Tuple[int, List[str]]]:
    """Returns unsorted (support_count, pattern) tuples for every pattern
    that appears — as a subsequence with between `min_gap` and `max_gap`
    other events allowed between consecutive pattern items — in at least
    `min_support_count` of the input sequences (S-support).

    `max_len` bounds how deep the recursion is allowed to go. Without it,
    sequences with many repeated/interleaved items and a low min_support_count
    (easy to hit by accident — see analytics.py's rounding fix) give this an
    exponential number of sub-sequences to enumerate, since almost nothing
    gets pruned by the support check. That showed up in practice as a
    request that never returns rather than an error."""
    results: List[Tuple[int, List[str]]] = []

    def _project(projected: List[List[str]], prefix: List[str]) -> None:
        # For each candidate next item, record (sequence_index, first_position)
        # — counting each sequence at most once per item, per PrefixSpan support.
        occurrences: Dict[str, List[Tuple[int, int]]] = {}
        for seq_idx, seq in enumerate(projected):
            seen = set()
            for pos, item in enumerate(seq):
                if item not in seen:
                    seen.add(item)
                    occurrences.setdefault(item, []).append((seq_idx, pos))

        for item, positions in occurrences.items():
            support = len(positions)
            if support < min_support_count:
                continue

            new_prefix = prefix + [item]
            if len(new_prefix) >= min_len:
                results.append((support, new_prefix))

            if max_len is not None and len(new_prefix) >= max_len:
                continue  # don't project any deeper past the length cap

            # Build the projected database: for each sequence that matched,
            # only the window [pos+1+min_gap, pos+1+max_gap] is eligible for
            # the NEXT pattern item — this is what enforces the gap bound
            # between consecutive pattern elements at every recursion level.
            next_projection = []
            for seq_idx, pos in positions:
                seq = projected[seq_idx]
                window_start = pos + 1 + min_gap
                window_end = len(seq) if max_gap is None else min(len(seq), pos + 1 + max_gap + 1)
                if window_start < window_end:
                    next_projection.append(seq[window_start:window_end])
            if next_projection:
                _project(next_projection, new_prefix)

    _project(sequences, [])
    return results


def count_instances(
    sequence: List[str],
    pattern: List[str],
    min_gap: int = 0,
    max_gap: Optional[int] = None,
) -> int:
    """Counts the number of NON-OVERLAPPING occurrences of `pattern` as a
    gap-constrained subsequence within a single `sequence`, using the
    standard greedy-leftmost matching strategy (Lo, Khoo & Li, 2008; Ding,
    Lo, Han & Khoo, 2009; Wu et al., 2020): repeatedly find the earliest
    valid match starting from wherever the previous match ended, so no
    event position is reused across instances. Summed and averaged across
    all sequences, this becomes a pattern's I-Frequency / I-Support
    (mean/sd)."""
    if not pattern:
        return 0

    n = len(sequence)
    count = 0
    search_from = 0

    while search_from < n:
        match_positions: List[int] = []
        ok = True
        for item in pattern:
            cursor = match_positions[-1] + 1 if match_positions else search_from
            found = None
            for pos in range(cursor, n):
                if sequence[pos] != item:
                    continue
                if match_positions:
                    gap = pos - match_positions[-1] - 1
                    if gap < min_gap:
                        continue
                    if max_gap is not None and gap > max_gap:
                        # Gaps only grow as pos increases, so no later
                        # position can satisfy the max_gap bound either —
                        # but a LATER occurrence of the first pattern item
                        # might still work (handled below).
                        break
                found = pos
                break
            if found is None:
                ok = False
                break
            match_positions.append(found)

        if ok:
            count += 1
            search_from = match_positions[-1] + 1
        elif match_positions:
            # This attempt (starting from the first item's match at
            # match_positions[0]) failed partway through. Don't give up on
            # the whole sequence — a later occurrence of the pattern's
            # first item may still yield a valid match.
            search_from = match_positions[0] + 1
        else:
            # The first pattern item doesn't occur again after search_from
            # at all — no further match is possible.
            break

    return count
