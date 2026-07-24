"use client";

import { useRef } from "react";
import type { JobOut } from "@/lib/types";

/** Checkbox list of processed videos, shared by every analytics tab that
 * lets the user pick a subset. Beyond plain click-to-toggle, shift+click
 * selects the inclusive range between the last-clicked row and this one
 * (e.g. check video 1, shift+click video 4 -> 1-4 all get checked),
 * unioned onto whatever was already selected.
 *
 * The toggle itself is driven by the checkbox's native `onChange` — we
 * never call `preventDefault()` on the click and manually flip state
 * ourselves. An earlier version did that (to read the shift-key modifier
 * at the same time), and it was the source of a real bug: fighting the
 * browser's own toggle occasionally left our state and the DOM's actual
 * checked state disagreeing, which showed up as clicking one row but a
 * *different* row ending up checked. Now the browser toggles the row you
 * actually clicked (it can't get that wrong), `onChange` just mirrors
 * that result into state, and the shift-key is captured separately in
 * `onClick` (which fires just before `change`) purely to decide whether
 * to widen the update into a range.
 *
 * `disabledIds` lets DSM gray out (and skip during range-select) rows
 * already claimed by the other group. */
export function JobSelectList({
  jobs,
  selected,
  onChange,
  disabledIds,
  maxHeightClassName = "max-h-96",
  emptyMessage = "No processed videos yet.",
}: {
  jobs: JobOut[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabledIds?: Set<string>;
  maxHeightClassName?: string;
  emptyMessage?: string;
}) {
  const lastClickedIndexRef = useRef<number | null>(null);
  const shiftKeyRef = useRef(false);

  function handleChange(jobId: string, index: number, checked: boolean) {
    if (disabledIds?.has(jobId)) return;
    const isShiftRange = shiftKeyRef.current && lastClickedIndexRef.current !== null;
    shiftKeyRef.current = false;

    if (isShiftRange) {
      const anchor = lastClickedIndexRef.current as number;
      const [from, to] = anchor < index ? [anchor, index] : [index, anchor];
      const next = new Set(selected);
      for (let i = from; i <= to; i++) {
        const id = jobs[i]?.job_id;
        if (id && !disabledIds?.has(id)) next.add(id);
      }
      onChange(next);
    } else {
      const next = new Set(selected);
      if (checked) next.add(jobId);
      else next.delete(jobId);
      onChange(next);
    }
    lastClickedIndexRef.current = index;
  }

  if (jobs.length === 0) {
    return <p className="px-2 py-4 text-sm text-neutral-500">{emptyMessage}</p>;
  }

  return (
    <ul className={`space-y-1 overflow-auto ${maxHeightClassName}`}>
      {jobs.map((job, index) => {
        const isDisabled = disabledIds?.has(job.job_id) ?? false;
        return (
          <li key={job.job_id}>
            <label
              className={`flex items-center gap-3 rounded-lg px-2 py-2 ${
                isDisabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-neutral-50"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(job.job_id)}
                disabled={isDisabled}
                onClick={(e) => {
                  shiftKeyRef.current = e.shiftKey;
                }}
                onChange={(e) => handleChange(job.job_id, index, e.target.checked)}
                className="h-4 w-4"
              />
              <span className="truncate text-sm text-text">{job.original_filename}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
