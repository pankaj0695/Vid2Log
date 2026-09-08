export type AlertTone = "primary" | "success" | "warning" | "danger";

const styles: Record<AlertTone, string> = {
  primary: "bg-primary-tint border-primary/20 text-primary-hover",
  success: "bg-success-tint border-success/20 text-success",
  warning: "bg-warning-tint border-warning/20 text-warning",
  danger: "bg-danger-tint border-danger/20 text-danger",
};

export function Alert({
  tone = "danger",
  title,
  className = "",
  onDismiss,
  dismissLabel = "Dismiss",
  children,
}: {
  tone?: AlertTone;
  title?: string;
  className?: string;
  /** When provided, renders a close button in the top-right corner. */
  onDismiss?: () => void;
  dismissLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`relative rounded-lg border px-4 py-3 text-sm ${styles[tone]} ${onDismiss ? "pr-10" : ""} ${className}`}
      role="alert"
    >
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={dismissLabel}
          title={dismissLabel}
          className="absolute right-2 top-2 rounded p-1 opacity-60 transition hover:bg-black/5 hover:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-current"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
      {title && <p className="font-medium">{title}</p>}
      <div className={title ? "mt-1 text-text/80" : ""}>{children}</div>
    </div>
  );
}
