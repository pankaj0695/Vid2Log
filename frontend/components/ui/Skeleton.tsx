/** Shimmering loading placeholders — used in place of a bare `<Spinner>`
 * wherever the real content has a predictable shape (a stat grid, a table,
 * a list of cards), so the page's layout doesn't visibly jump once data
 * arrives and the wait itself reads as "in progress" rather than "stuck".
 * All built on the `.animate-shimmer` sweep defined in globals.css. */

import type { CSSProperties } from "react";

function Base({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div className={`animate-shimmer rounded-md ${className}`} style={style} />;
}

/** A single shimmering block/line — the primitive everything else composes. */
export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <Base className={className} style={style} />;
}

/** A paragraph of placeholder text lines, each a slightly different width
 * so it reads as text rather than a uniform gray bar. */
export function SkeletonText({ lines = 3, className = "" }: { lines?: number; className?: string }) {
  const widths = ["100%", "92%", "76%", "88%", "64%"];
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} style={{ width: widths[i % widths.length] }}>
          <Base className="h-3" />
        </div>
      ))}
    </div>
  );
}

/** Mirrors StatCard's layout exactly (label / big mono number / hint) so a
 * stat grid's loading state occupies the same footprint as its loaded
 * state. */
export function SkeletonStatCard() {
  return (
    <div className="rounded-xl border border-neutral-200 bg-surface p-6">
      <Skeleton className="h-3.5 w-24" />
      <Skeleton className="mt-3 h-8 w-16" />
      <Skeleton className="mt-2 h-3 w-20" />
    </div>
  );
}

/** A grid of `count` skeleton stat cards, staggered slightly so they don't
 * all shimmer in perfect lockstep. */
export function SkeletonStatGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="animate-fade-in-up" style={{ "--stagger": `${i * 60}ms` } as CSSProperties}>
          <SkeletonStatCard />
        </div>
      ))}
    </div>
  );
}

/** A table's worth of placeholder rows, `cols` cells wide. Matches the
 * padding/divider look of the real `<table>` markup used throughout the
 * app (`divide-y divide-neutral-100`, `px-3 py-3`), so swapping it out for
 * real rows doesn't shift the surrounding layout. */
export function SkeletonTable({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-neutral-100">
      {Array.from({ length: rows }).map((_, r) => (
        <div
          key={r}
          className="animate-fade-in-up flex items-center gap-4 px-3 py-3"
          style={{ "--stagger": `${r * 45}ms` } as CSSProperties}
        >
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className={`h-3.5 ${c === 0 ? "w-1/3" : "flex-1"}`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** A vertical list of simple rows — e.g. a video-select checklist or an
 * activity feed — each just an icon/checkbox-sized block plus a line of
 * text. */
export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-1">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="animate-fade-in-up flex items-center gap-3 rounded-lg px-2 py-2"
          style={{ "--stagger": `${i * 45}ms` } as CSSProperties}
        >
          <Skeleton className="h-4 w-4 shrink-0 rounded" />
          <Skeleton className="h-3.5 flex-1" style={{ maxWidth: `${60 + ((i * 13) % 30)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** A generic card-shaped placeholder — a title-sized bar plus a couple of
 * body lines — for card grids whose real content isn't tabular (e.g. the
 * model registry's card layout). */
export function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <div className={`rounded-xl border border-neutral-200 bg-surface p-6 ${className}`}>
      <Skeleton className="h-4 w-2/3" />
      <SkeletonText lines={2} className="mt-4" />
    </div>
  );
}
