"""
A minimal, dependency-free Sequential Pattern Mining implementation
(PrefixSpan-style) for single-symbol sequences — each processed video's
chronological list of activity-class labels, e.g.
["ProblemStatement", "GameWorkspace", "ProductSelection", ...].

We hand-roll this instead of depending on the `prefixspan` PyPI package
because it pulls in `extratools`, an unmaintained package that hard-pins
ancient versions of common libraries (e.g. `Pillow==1.7.8`, from ~2010) —
which fails to build on modern Python/macOS (`use_2to3 is invalid`) and
breaks `pip install` entirely. The algorithm itself is short enough
(~30 lines) that it isn't worth carrying that dependency risk.

Support here follows the standard PrefixSpan definition: the number of
distinct input sequences that contain the pattern as a (not necessarily
contiguous) subsequence at least once.
"""
from typing import Dict, List, Optional, Tuple


def frequent_patterns(
    sequences: List[List[str]],
    min_support_count: int,
    min_len: int = 1,
    max_len: Optional[int] = None,
) -> List[Tuple[int, List[str]]]:
    """Returns unsorted (support_count, pattern) tuples for every pattern
    that appears in at least `min_support_count` of the input sequences.

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

            # Build the projected database: everything after this item's
            # first occurrence in each sequence that contained it.
            next_projection = [
                projected[seq_idx][pos + 1 :]
                for seq_idx, pos in positions
                if projected[seq_idx][pos + 1 :]
            ]
            if next_projection:
                _project(next_projection, new_prefix)

    _project(sequences, [])
    return results
