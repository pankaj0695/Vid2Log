import type { HTMLAttributes } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Opts into the hover "lift" treatment (small upward nudge + soft
   * shadow) — for cards that are actually clickable (e.g. a model row
   * linking to its detail page), not the many purely-informational cards
   * this component is also used for. */
  interactive?: boolean;
}

export function Card({ className = "", interactive = false, ...props }: CardProps) {
  return (
    <div
      className={`rounded-xl border border-neutral-200 bg-surface p-6 transition-colors ${
        interactive ? "hover-lift" : ""
      } ${className}`}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h3 className="font-display text-lg font-semibold text-text">{title}</h3>
        {description && <p className="mt-1 text-sm text-neutral-600">{description}</p>}
      </div>
      {action}
    </div>
  );
}
