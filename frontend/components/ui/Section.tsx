export function Container({ className = "", ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 ${className}`} {...props} />;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        {eyebrow && (
          <p className="mb-1.5 font-mono text-xs font-semibold uppercase tracking-widest text-primary">{eyebrow}</p>
        )}
        <h1 className="text-4xl font-semibold text-text">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-base text-neutral-600">{description}</p>}
      </div>
      {action}
    </div>
  );
}
