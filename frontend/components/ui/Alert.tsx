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
  children,
}: {
  tone?: AlertTone;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm ${styles[tone]} ${className}`} role="alert">
      {title && <p className="font-medium">{title}</p>}
      <div className={title ? "mt-1 text-text/80" : ""}>{children}</div>
    </div>
  );
}
