/** Reusable pill-tab bar for in-page sub-views (e.g. Dashboard's
 * Overview/Models/Activity, Analytics' Overview/SPM/DSM/Video timeline).
 * Extracted from the pattern the Analytics page already used for SPM/DSM. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="mb-6 inline-flex flex-wrap rounded-lg border border-neutral-200 p-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
            active === tab.id ? "bg-primary text-ink" : "text-neutral-500 hover:bg-neutral-100 hover:text-text"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
