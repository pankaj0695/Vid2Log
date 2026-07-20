export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-surface p-6">
      <p className="text-sm font-medium text-neutral-500">{label}</p>
      <p className="mt-2 font-mono text-4xl font-semibold text-text">{value}</p>
      {hint && <p className="mt-1 text-sm text-neutral-500">{hint}</p>}
    </div>
  );
}
