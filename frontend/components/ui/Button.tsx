import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

// `active:scale-[0.97]` gives every button a small, tactile press-down
// on click — the kind of physical feedback that reads as "this is a real
// control" rather than a flat hit-target. Duration is short (150ms) so it
// never feels sluggish; `prefers-reduced-motion` zeroes it out globally
// (see globals.css) same as every other transition here.
const base =
  "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150 ease-out " +
  "active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none disabled:active:scale-100 whitespace-nowrap";

// primary/secondary/danger are all bright, high-luminance fills in the dark
// palette — dark "ink" text on top of them (not white) is what keeps AA
// contrast and matches the reference's dark-text-on-teal buttons. The
// filled variants also get a soft tinted glow on hover (shadow, not a
// darker fill) — a small "this is the primary action" cue big-product UIs
// lean on that a flat color-swap hover doesn't give you.
const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-ink hover:bg-primary-hover shadow-[0_0_0_0_transparent] hover:shadow-[0_8px_20px_-8px_var(--color-primary)]",
  secondary: "bg-secondary text-ink hover:bg-secondary-hover shadow-[0_0_0_0_transparent] hover:shadow-[0_8px_20px_-8px_var(--color-secondary)]",
  outline: "border border-neutral-300 text-text bg-surface hover:bg-neutral-100 hover:border-neutral-400",
  ghost: "text-text hover:bg-neutral-100",
  danger: "bg-danger text-ink hover:opacity-90 shadow-[0_0_0_0_transparent] hover:shadow-[0_8px_20px_-8px_var(--color-danger)]",
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
