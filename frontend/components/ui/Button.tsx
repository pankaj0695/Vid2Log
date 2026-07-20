import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors " +
  "disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap";

// primary/secondary/danger are all bright, high-luminance fills in the dark
// palette — dark "ink" text on top of them (not white) is what keeps AA
// contrast and matches the reference's dark-text-on-teal buttons.
const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-ink hover:bg-primary-hover",
  secondary: "bg-secondary text-ink hover:bg-secondary-hover",
  outline: "border border-neutral-300 text-text bg-surface hover:bg-neutral-100",
  ghost: "text-text hover:bg-neutral-100",
  danger: "bg-danger text-ink hover:opacity-90",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm",
  md: "h-11 px-4 text-base",
  lg: "h-12 px-6 text-lg",
};

export function buttonClasses(opts: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  const { variant = "primary", size = "md", className = "" } = opts;
  return [base, variants[variant], sizes[size], className].filter(Boolean).join(" ");
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, disabled, className, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={buttonClasses({ variant, size, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner size="sm" tone={variant === "outline" || variant === "ghost" ? "primary" : "ink"} />}
      {children}
    </button>
  );
});
