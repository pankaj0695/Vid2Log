"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Kept in sync with Navbar.tsx's APP_SHELL_PREFIXES — those sections have
// their own Sidebar/Topbar shell and don't want the marketing footer below
// their content.
const APP_SHELL_PREFIXES = [
  "/dashboard",
  "/train",
  "/process",
  "/analytics",
  "/admin",
  "/models",
];

export function Footer() {
  const pathname = usePathname();
  if (APP_SHELL_PREFIXES.some((p) => pathname.startsWith(p))) return null;

  return (
    <footer className="mt-24 border-t border-neutral-200 bg-neutral-50">
      <div className="dither-divider" aria-hidden="true" />
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div>
            <p className="flex items-center gap-2 font-display text-lg font-bold text-text">
              <Image
                src="/vid2log-logo.png"
                alt=""
                width={24}
                height={24}
                className="shrink-0"
              />
              vid2log
            </p>
            <p className="mt-1 max-w-sm text-sm text-neutral-600">
              Train a classifier on your app&apos;s screens, then turn any
              screen recording into a structured activity log automatically.
            </p>
          </div>
          <nav
            className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-neutral-600"
            aria-label="Footer"
          >
            <Link href="/#how-it-works" className="hover:text-text">
              How it works
            </Link>
            <Link href="/#features" className="hover:text-text">
              Features
            </Link>
            <Link href="/login" className="hover:text-text">
              Log in
            </Link>
            <Link href="/signup" className="hover:text-text">
              Get started
            </Link>
          </nav>
        </div>
        <p className="mt-8 text-sm text-neutral-400">
          Built for IIT Bombay research &amp; learning-platform video analysis.
        </p>
      </div>
    </footer>
  );
}
