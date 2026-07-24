"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { ThemeToggleSegmented } from "@/components/ThemeToggle";
import {
  IconGrid,
  IconSliders,
  IconFilm,
  IconChartBar,
  IconShield,
  IconSidebarToggle,
} from "./icons";

export type SectionId =
  | "dashboard"
  | "train"
  | "process"
  | "analytics"
  | "admin";

const NAV: {
  id: SectionId;
  href: string;
  label: string;
  icon: typeof IconGrid;
}[] = [
  { id: "dashboard", href: "/dashboard", label: "Dashboard", icon: IconGrid },
  { id: "train", href: "/train", label: "Train", icon: IconSliders },
  { id: "process", href: "/process", label: "Process video", icon: IconFilm },
  {
    id: "analytics",
    href: "/analytics",
    label: "Analytics",
    icon: IconChartBar,
  },
];

function initials(name: string | null, email: string | null): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return (email || "?")[0].toUpperCase();
}

function LogoMark() {
  return (
    <Image
      src="/vid2log-logo.png"
      alt=""
      width={28}
      height={28}
      className="shrink-0"
    />
  );
}

function NavList({
  active,
  onNavigate,
}: {
  active: SectionId;
  onNavigate?: () => void;
}) {
  const { isAdmin } = useAuth();
  const items = isAdmin
    ? [
        ...NAV,
        {
          id: "admin" as const,
          href: "/admin",
          label: "Admin",
          icon: IconShield,
        },
      ]
    : NAV;

  return (
    <nav className="flex-1 space-y-1 px-3" aria-label="Primary">
      {items.map((item) => {
        const isActive = item.id === active;
        const Icon = item.icon;
        return (
          <Link
            key={item.id}
            href={item.href}
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
              isActive
                ? "bg-primary-tint text-primary-hover"
                : "text-neutral-500 hover:bg-neutral-100 hover:text-text"
            }`}
          >
            <Icon className="shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function AccountFooter({ onNavigate }: { onNavigate?: () => void }) {
  const { profile, firebaseUser, logout } = useAuth();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  async function handleLogout() {
    setMenuOpen(false);
    onNavigate?.();
    await logout();
    router.push("/");
  }

  return (
    <div className="border-t border-neutral-200 p-3">
      <div className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-neutral-100"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-ink">
            {initials(
              profile?.display_name ?? null,
              profile?.email ?? firebaseUser?.email ?? null,
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text">
              {profile?.display_name || "Account"}
            </p>
            <p className="truncate text-xs text-neutral-500">
              {profile?.email ?? firebaseUser?.email}
            </p>
          </div>
        </button>

        {menuOpen && (
          <>
            {/* Click-outside catcher */}
            <div
              className="fixed inset-0 z-[90]"
              onClick={() => setMenuOpen(false)}
              aria-hidden="true"
            />
            <div
              role="menu"
              className="absolute bottom-full left-0 z-[100] mb-2 w-full rounded-xl border border-neutral-200 bg-surface p-1.5 shadow-lg"
            >
              <ThemeToggleSegmented />
              <div className="my-1 border-t border-neutral-100" />
              <button
                role="menuitem"
                onClick={handleLogout}
                className="w-full rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-danger-tint"
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Persistent left rail on desktop (md+); collapses to a top strip + slide
 * -over drawer on mobile. This is the app-wide section switcher — each
 * section's own sub-views live in an in-page tab bar (see Tabs.tsx), not
 * here, so the sidebar itself never has to change shape between pages. */
export function Sidebar({
  active,
  collapsed,
  onToggleCollapsed,
}: {
  active: SectionId;
  /** Desktop-only — collapsing on mobile isn't a thing here, the mobile
   * top strip + drawer below already covers hide/show. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile top strip */}
      <div className="flex items-center justify-between border-b border-neutral-200 bg-surface px-4 py-3 md:hidden">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 font-display text-base font-bold text-text"
        >
          <LogoMark />
          vid2log
        </Link>
        <button
          onClick={() => setMobileOpen(true)}
          className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100"
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M4 6h16M4 12h16M4 18h16"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col bg-surface">
            <div className="flex items-center justify-between px-4 py-4">
              <Link
                href="/dashboard"
                className="flex items-center gap-2 font-display text-base font-bold text-text"
              >
                <LogoMark />
                vid2log
              </Link>
              <button
                onClick={() => setMobileOpen(false)}
                className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100"
                aria-label="Close navigation"
              >
                ✕
              </button>
            </div>
            <NavList active={active} onNavigate={() => setMobileOpen(false)} />
            <AccountFooter onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}

      {/* Desktop rail — sticky + viewport-height so it stays put while the
       * content column scrolls, instead of scrolling away with the page.
       * Overflow scrolling lives on the inner nav wrapper only, NOT this
       * outer <aside> — putting overflow-y-auto on the aside itself clips
       * anything that overflows its box, including the account popup above
       * it (see AccountFooter — it opens upward, not to the side).
       * When collapsed, this renders NOTHING — no logo, no reserved width —
       * the content column expands to fill the space; Topbar shows the
       * reopen button instead, since there's nothing left here to show it
       * on. */}
      {!collapsed && (
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-neutral-200 bg-surface md:flex">
          <div className="flex items-center justify-between px-5 py-5">
            <Link
              href="/dashboard"
              className="flex items-center gap-2 font-display text-lg font-bold text-text"
            >
              <LogoMark />
              vid2log
            </Link>
            <button
              onClick={onToggleCollapsed}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-text"
              aria-label="Close sidebar"
            >
              <IconSidebarToggle />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <NavList active={active} />
          </div>
          <AccountFooter />
        </aside>
      )}
    </>
  );
}
