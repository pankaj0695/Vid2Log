import { IconSidebarToggle } from "./icons";

/** Slim breadcrumb bar above each section's content. Deliberately minimal —
 * no search box or notification bell, since neither would have anything
 * real behind it yet (no cross-entity search index, no notifications
 * system). Faking either would read as unfinished chrome rather than a
 * finished product; better to add them later if/when there's something
 * real for them to do.
 *
 * When the desktop sidebar is collapsed, Sidebar itself renders nothing (no
 * logo, no reserved width) — so the way back in lives here instead, at this
 * bar's own left edge. `hidden md:flex` on that button because collapsing
 * is a desktop-only concept; the sidebar is already hidden on mobile via
 * its own top strip + drawer, `sidebarCollapsed` isn't meaningful there. */
export function Topbar({
  crumb,
  sidebarCollapsed,
  onExpandSidebar,
}: {
  crumb: string;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
}) {
  return (
    <div className="sticky top-0 z-30 flex items-center gap-3 border-b border-neutral-200 bg-surface/90 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
      {sidebarCollapsed && (
        <button
          onClick={onExpandSidebar}
          className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-text md:flex"
          aria-label="Open sidebar"
        >
          <IconSidebarToggle />
        </button>
      )}
      <p className="font-mono text-sm text-neutral-500">
        vid2log <span className="mx-1 text-neutral-300">/</span> <span className="text-text">{crumb}</span>
      </p>
    </div>
  );
}
