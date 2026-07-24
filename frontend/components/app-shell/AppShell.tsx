"use client";

import { useState } from "react";
import { Sidebar, type SectionId } from "./Sidebar";
import { Topbar } from "./Topbar";

const SIDEBAR_COLLAPSED_KEY = "vid2log-sidebar-collapsed";

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
 * run — until auth has actually resolved.
 *
 * The "collapsed" (desktop sidebar hidden entirely) state lives HERE, not
 * in Sidebar itself, because collapsing needs to be visible to Topbar too
 * (it shows the reopen button at its own left edge when there's no sidebar
 * to show it) — a sibling can't reach into another sibling's local state,
 * so it has to live in their shared parent. */
export function AppShell({
  section,
  crumb,
  children,
}: {
  section: SectionId;
  crumb: string;
  children: React.ReactNode;
}) {
  // Lazy initializer (not an effect) reads the saved preference on first
  // client render — this whole tree only ever mounts client-side (it sits
  // behind ProtectedRoute's auth check, which never finishes during SSR),
  // so there's no server/client mismatch to guard against here.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  });

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar active={section} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar crumb={crumb} sidebarCollapsed={collapsed} onExpandSidebar={toggleCollapsed} />
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}
