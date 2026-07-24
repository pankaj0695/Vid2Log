"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** Wraps next-themes: `attribute="data-theme"` matches the
 * `[data-theme="light"]` selector in globals.css (dark is the bare
 * `:root` default), `defaultTheme="system"` + `enableSystem` means a
 * first-time visitor gets whatever their OS is set to, and picking Light
 * or Dark explicitly (see components/ThemeToggle.tsx) persists that choice
 * in localStorage from then on, overriding system-following. next-themes
 * also injects the anti-flash inline script itself, so there's no
 * flash-of-wrong-theme on load even though this is a client component. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="data-theme" defaultTheme="system" enableSystem>
      {children}
    </NextThemesProvider>
  );
}
