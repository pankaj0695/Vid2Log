export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="dither-dots rounded-xl border border-dashed border-neutral-300 bg-neutral-50/40 px-6 py-14 text-center">
      <p className="font-display text-lg font-semibold text-text">{title}</p>
      {description && <p className="mx-auto mt-2 max-w-md text-sm text-neutral-600">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
