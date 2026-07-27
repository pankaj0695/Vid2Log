import type { CSSProperties } from "react";

export function StatCard({
  label,
  value,
  hint,
  style,
}: {
  label: string;
  value: string | number;
  hint?: string;
  /** Pass `{ "--stagger": "80ms" } as CSSProperties` to cascade a row of
   * stat cards in one after another instead of all at once — see
   * SkeletonStatGrid for the loading-state equivalent. */
  style?: CSSProperties;
}) {
  return (
    <div
      className="hover-lift animate-fade-in-up rounded-xl border border-neutral-200 bg-surface p-6"
      style={style}
    >
      <p className="text-sm font-medium text-neutral-500">{label}</p>
      <p className="mt-2 font-mono text-4xl font-semibold text-text">{value}</p>
      {hint && <p className="mt-1 text-sm text-neutral-500">{hint}</p>}
    </div>
  );
}
