import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { IconInfo } from "@/components/app-shell/icons";

const fieldBase =
  "w-full rounded-lg border border-neutral-300 bg-surface px-3 h-11 text-base text-text " +
  "placeholder:text-neutral-400 focus-visible:border-primary disabled:bg-neutral-100 disabled:text-neutral-400";

/**
 * A field label, optionally carrying a short explanation.
 *
 * Many of the inputs in this app name a real parameter that a non-technical
 * researcher has no way to guess at ("Sliding Window Max", "S Support
 * Threshold", "Learning rate"). Passing `tooltip` puts a small info icon
 * after the label text which explains it on hover, so the field can keep its
 * correct technical name without stranding the reader.
 *
 * The icon carries `aria-hidden` inside the tooltip wrapper and the text is
 * exposed through the tooltip's own `role="tooltip"` span, so screen readers
 * announce the explanation rather than an unlabelled graphic.
 */
export function Label({
  className = "",
  tooltip,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { tooltip?: string }) {
  return (
    <label className={`mb-1.5 flex items-center gap-1.5 text-sm font-medium text-text ${className}`} {...props}>
      {children}
      {tooltip && (
        <Tooltip label={tooltip}>
          <span className="text-neutral-400 transition-colors hover:text-primary">
            <IconInfo />
          </span>
        </Tooltip>
      )}
    </label>
  );
}

export function HelpText({ error, children }: { error?: boolean; children: React.ReactNode }) {
  return <p className={`mt-1.5 text-sm ${error ? "text-danger" : "text-neutral-500"}`}>{children}</p>;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function Input({ className = "", invalid, ...props }, ref) {
    return (
      <input
        ref={ref}
        className={`${fieldBase} ${invalid ? "border-danger" : ""} ${className}`}
        aria-invalid={invalid || undefined}
        {...props}
      />
    );
  }
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = "", ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={`${fieldBase} h-auto min-h-24 py-2.5 resize-y ${className}`}
        {...props}
      />
    );
  }
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = "", children, ...props },
  ref
) {
  return (
    <select ref={ref} className={`${fieldBase} pr-8 ${className}`} {...props}>
      {children}
    </select>
  );
});
