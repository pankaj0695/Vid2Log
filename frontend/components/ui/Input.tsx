import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

const fieldBase =
  "w-full rounded-lg border border-neutral-300 bg-surface px-3 h-11 text-base text-text " +
  "placeholder:text-neutral-400 focus-visible:border-primary disabled:bg-neutral-100 disabled:text-neutral-400";

export function Label({ className = "", ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={`mb-1.5 block text-sm font-medium text-text ${className}`} {...props} />;
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
