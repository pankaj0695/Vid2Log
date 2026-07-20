"use client";

import { Sidebar, type SectionId } from "./Sidebar";
import { Topbar } from "./Topbar";

/** Shared visual chrome for every authenticated page: sidebar (section
 * switcher) + breadcrumb topbar, in one place instead of copy-pasted per
 * page. Each page still owns its own in-page tabs/content (see
 * components/ui/Tabs.tsx) — this component only owns the app-wide frame.
 *
 * Deliberately does NOT wrap children in <ProtectedRoute> itself — that has
 * to wrap the whole page-content component from the OUTSIDE (see each
 * page's default export), not be nested inside it. A page's content
 * component fires its own data-fetching useEffects the moment IT mounts,
 * regardless of what JSX it happens to render further down; if
 * ProtectedRoute only gated the return value of THIS component, the
 * content component would already have mounted (and already fired its
 * fetches, with no auth token yet available on a fresh page load) before
 * ProtectedRoute ever got a chance to hide anything. Wrapping the content
 * component from the outside means it doesn't mount — so its effects don't
 * run — until auth has actually resolved. */
export function AppShell({
  section,
  crumb,
  children,
}: {
  section: SectionId;
  crumb: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar active={section} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar crumb={crumb} />
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
