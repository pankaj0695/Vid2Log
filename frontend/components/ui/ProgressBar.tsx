export function ProgressBar({ fraction, tone = "primary" }: { fraction: number; tone?: "primary" | "secondary" }) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const color = tone === "primary" ? "bg-primary" : "bg-secondary";
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-neutral-200"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`h-full ${color} transition-[width] duration-300 ease-out`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** For work that's genuinely in progress but has no real percentage to
 * report (e.g. one long awaited request with no per-chunk feedback) — a
 * short highlight sweeps the track on a loop so it still reads as "actively
 * working," unlike a static/empty bar. */
export function IndeterminateProgressBar({ tone = "primary" }: { tone?: "primary" | "secondary" }) {
  const color = tone === "primary" ? "bg-primary" : "bg-secondary";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200" role="progressbar" aria-label="Loading">
      <div className={`h-full w-1/4 rounded-full ${color} animate-progress-indeterminate`} />
    </div>
  );
}
