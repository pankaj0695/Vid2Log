export function Spinner({
  size = "md",
  tone = "primary",
  label,
}: {
  size?: "sm" | "md" | "lg";
  tone?: "primary" | "white" | "ink" | "neutral";
  label?: string;
}) {
  const dims = { sm: "h-4 w-4", md: "h-6 w-6", lg: "h-9 w-9" }[size];
  const color = {
    primary: "border-primary",
    white: "border-white",
    ink: "border-ink",
    neutral: "border-neutral-500",
  }[tone];

  return (
    <span className="inline-flex items-center gap-3" role="status" aria-live="polite">
      <span
        className={`${dims} ${color} animate-spin rounded-full border-2 border-t-transparent`}
        aria-hidden="true"
      />
      {label ? <span className="text-sm text-neutral-600">{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}
