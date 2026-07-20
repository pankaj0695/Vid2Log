export type BadgeTone = "primary" | "secondary" | "success" | "warning" | "danger" | "neutral";

const tones: Record<BadgeTone, string> = {
  primary: "bg-primary-tint text-primary-hover",
  secondary: "bg-secondary-tint text-secondary-hover",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
  danger: "bg-danger-tint text-danger",
  neutral: "bg-neutral-100 text-neutral-700",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

const statusTone: Record<string, BadgeTone> = {
  queued: "neutral",
  processing: "primary",
  done: "success",
  failed: "danger",
  cancelled: "warning",
};

/** Maps job/training-job status strings straight to a consistent badge. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={statusTone[status] ?? "neutral"}>
      <span
        className="h-1.5 w-1.5 rounded-full bg-current"
        aria-hidden="true"
      />
      {status}
    </Badge>
  );
}
