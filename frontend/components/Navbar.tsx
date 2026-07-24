"use client";

import { useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useClickOutside } from "@/lib/useClickOutside";
import { buttonClasses } from "./ui/Button";
import { ThemeToggleButton, ThemeToggleSegmented } from "./ThemeToggle";

const navLinks = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/train", label: "Train" },
  { href: "/process", label: "Process video" },
  { href: "/analytics", label: "Analytics" },
];

// These sections render their own Sidebar/Topbar shell (see
// components/app-shell/), which replaces this top navbar entirely — showing
// both would be redundant, duplicate navigation.
const APP_SHELL_PREFIXES = [
  "/dashboard",
  "/train",
  "/process",
  "/analytics",
  "/admin",
  "/models",
];

function initials(name: string | null, email: string | null): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
  }
  return (email || "?")[0].toUpperCase();
}

export function Navbar() {
  const { firebaseUser, profile, isAdmin, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(accountMenuRef, () => setMenuOpen(false), menuOpen);

  async function handleLogout() {
    setMenuOpen(false);
    await logout();
    router.push("/");
  }

  if (APP_SHELL_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-200 bg-surface/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex items-center gap-2 font-display text-xl font-bold tracking-tight text-text"
        >
          <Image
            src="/vid2log-logo.png"
            alt=""
            width={28}
            height={28}
            className="shrink-0"
          />
          vid2log
        </Link>

        {firebaseUser && (
          <nav
            className="hidden items-center gap-1 md:flex"
            aria-label="Primary"
          >
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  pathname === link.href
                    ? "bg-primary-tint text-primary-hover"
                    : "text-neutral-600 hover:bg-neutral-100 hover:text-text"
                }`}
              >
                {link.label}
              </Link>
            ))}
            {isAdmin && (
              <Link
                href="/admin"
                className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  pathname === "/admin"
                    ? "bg-secondary-tint text-secondary-hover"
                    : "text-neutral-600 hover:bg-neutral-100 hover:text-text"
                }`}
              >
                Admin
              </Link>
            )}
          </nav>
        )}

        <div className="flex items-center gap-3">
          {loading ? (
            <div className="h-9 w-24 animate-pulse rounded-lg bg-neutral-100" />
          ) : firebaseUser ? (
            <div className="relative" ref={accountMenuRef}>
              <button
                onClick={() => setMenuOpen((v) => !v)}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-ink"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="Account menu"
              >
                {initials(
                  profile?.display_name ?? null,
                  profile?.email ?? firebaseUser.email,
                )}
              </button>
              {menuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 z-[100] mt-2 w-56 rounded-xl border border-neutral-200 bg-surface p-1.5 shadow-lg"
                >
                  <div className="border-b border-neutral-100 px-3 py-2">
                    <p className="truncate text-sm font-medium text-text">
                      {profile?.display_name || "Account"}
                    </p>
                    <p className="truncate text-sm text-neutral-500">
                      {profile?.email ?? firebaseUser.email}
                    </p>
                    {profile?.role === "admin" && (
                      <span className="mt-1 inline-block rounded-full bg-secondary-tint px-2 py-0.5 text-sm font-medium text-secondary-hover">
                        admin
                      </span>
                    )}
                  </div>
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
              )}
            </div>
          ) : (
            <div className="hidden items-center gap-2 sm:flex">
              <Link
                href="/login"
                className={buttonClasses({ variant: "ghost", size: "sm" })}
              >
                Log in
              </Link>
              <Link
                href="/signup"
                className={buttonClasses({ variant: "primary", size: "sm" })}
              >
                Get started
              </Link>
              <ThemeToggleButton />
            </div>
          )}

          {firebaseUser && (
            <button
              className="rounded-lg p-2 text-neutral-600 hover:bg-neutral-100 md:hidden"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label="Toggle menu"
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
          )}
        </div>
      </div>

      {firebaseUser && mobileOpen && (
        <nav
          className="border-t border-neutral-200 px-4 py-2 md:hidden"
          aria-label="Primary mobile"
        >
          {[
            ...navLinks,
            ...(isAdmin ? [{ href: "/admin", label: "Admin" }] : []),
          ].map((link) => (
            <Link
              key={link.href}
              href={link.href}
              onClick={() => setMobileOpen(false)}
              className="block rounded-lg px-3 py-2.5 text-base text-text hover:bg-neutral-100"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      )}

      {!firebaseUser && !loading && (
        <div className="flex items-center gap-2 border-t border-neutral-200 px-4 py-2 sm:hidden">
          <Link
            href="/login"
            className={buttonClasses({
              variant: "ghost",
              size: "sm",
              className: "flex-1",
            })}
          >
            Log in
          </Link>
          <Link
            href="/signup"
            className={buttonClasses({
              variant: "primary",
              size: "sm",
              className: "flex-1",
            })}
          >
            Get started
          </Link>
          <ThemeToggleButton />
        </div>
      )}
    </header>
  );
}
