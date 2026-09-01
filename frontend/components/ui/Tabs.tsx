import { Tooltip } from "./Tooltip";

/** Reusable pill-tab bar for in-page sub-views (e.g. Dashboard's
 * Overview/Models/Activity, Analytics' Overview/SPM/DSM/Video timeline).
 * Extracted from the pattern the Analytics page already used for SPM/DSM.
 * `tooltip` is optional per-tab — a short (3-5 word) plain-language
 * description shown on hover, for non-technical users unsure what a tab
 * like "SPM" actually shows. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string; tooltip?: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="mb-6 inline-flex flex-wrap rounded-lg border border-neutral-200 p-1" role="tablist">
      {tabs.map((tab) => {
        const button = (
          <button
            role="tab"
            aria-selected={active === tab.id}
            onClick={() => onChange(tab.id)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-all duration-200 ease-out ${
              active === tab.id
                ? "bg-primary text-ink shadow-[0_4px_14px_-6px_var(--color-primary)]"
                : "text-neutral-500 hover:bg-neutral-100 hover:text-text"
            }`}
          >
            {tab.label}
          </button>
        );
        return tab.tooltip ? (
          <Tooltip key={tab.id} label={tab.tooltip} side="bottom">
            {button}
          </Tooltip>
        ) : (
          <span key={tab.id}>{button}</span>
        );
      })}
    </div>
  );
}
