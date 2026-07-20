/** Slim breadcrumb bar above each section's content. Deliberately minimal —
 * no search box or notification bell, since neither would have anything
 * real behind it yet (no cross-entity search index, no notifications
 * system). Faking either would read as unfinished chrome rather than a
 * finished product; better to add them later if/when there's something
 * real for them to do. */
export function Topbar({ crumb }: { crumb: string }) {
  return (
    <div className="sticky top-0 z-30 border-b border-neutral-200 bg-surface/90 px-4 py-3 backdrop-blur sm:px-6 lg:px-8">
      <p className="font-mono text-sm text-neutral-500">
        vid2log <span className="mx-1 text-neutral-300">/</span> <span className="text-text">{crumb}</span>
      </p>
    </div>
  );
}
