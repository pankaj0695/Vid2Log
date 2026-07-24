"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

// "Have we mounted on the client yet" via useSyncExternalStore (subscribe is
// a no-op — nothing external ever changes) rather than the more common
// useState+useEffect(() => setMounted(true)) idiom: that pattern trips this
// repo's react-hooks/set-state-in-effect lint rule, and this is React's own
// documented alternative for exactly this "differ from the server snapshot
// once safely on the client" case, with no extra render-then-setState pass.
function useMounted() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

type IconProps = { className?: string };

function IconSun({ className }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMoon({ className }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path
        d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Shared toggle logic for both ThemeToggleSegmented and ThemeToggleButton
 * below.
 *
 * `mounted` guards against a hydration mismatch: next-themes can't know the
 * resolved theme on the server (it depends on localStorage/matchMedia,
 * neither of which exist there), so `resolvedTheme` is `undefined` until
 * after the first client render — every consumer must render a neutral
 * placeholder until `mounted` flips true, then switch to the real icon.
 *
 * `set()` briefly adds `.theme-transitioning` to <html> so the CSS-variable
 * driven color change (see globals.css) fades instead of hard-cutting, then
 * removes it once the transition would be done — this class is deliberately
 * NOT present at initial load, only during a user-initiated switch. */
function useThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();

  function set(mode: "light" | "dark") {
    const html = document.documentElement;
    html.classList.add("theme-transitioning");
    setTheme(mode);
    window.setTimeout(() => html.classList.remove("theme-transitioning"), 300);
  }

  return { mounted, resolvedTheme, set };
}

/** Two-option Light/Dark segmented control for account dropdown menus
 * (Navbar's account menu, Sidebar's AccountFooter) — sits above the
 * "Sign out" item. */
export function ThemeToggleSegmented() {
  const { mounted, resolvedTheme, set } = useThemeToggle();
  const active = mounted ? resolvedTheme : undefined;

  return (
    <div className="px-3 py-2">
      <p className="mb-1.5 text-xs font-medium text-neutral-500">Appearance</p>
      <div className="flex gap-1 rounded-lg bg-neutral-100 p-1">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={active === "light"}
          onClick={() => set("light")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-colors ${
            active === "light" ? "bg-surface text-text shadow-sm" : "text-neutral-500 hover:text-text"
          }`}
        >
          <IconSun />
          Light
        </button>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={active === "dark"}
          onClick={() => set("dark")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-colors ${
            active === "dark" ? "bg-surface text-text shadow-sm" : "text-neutral-500 hover:text-text"
          }`}
        >
          <IconMoon />
          Dark
        </button>
      </div>
    </div>
  );
}

/** Single click-to-toggle icon button for the logged-out Navbar, shown next
 * to "Get started" — no dropdown needed when there's no account menu to
 * attach it to. Shows the icon for the mode a click would SWITCH TO (sun
 * while dark is active — tap for light; moon while light is active — tap
 * for dark), not the currently-active mode. */
export function ThemeToggleButton({ className = "" }: { className?: string }) {
  const { mounted, resolvedTheme, set } = useThemeToggle();

  return (
    <button
      type="button"
      onClick={() => set(resolvedTheme === "dark" ? "light" : "dark")}
      aria-label={mounted ? `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode` : "Toggle color theme"}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-text ${className}`}
    >
      {/* Invisible until mounted (not `null`) so layout doesn't shift once
       * the real icon appears — same-size box either way. */}
      <span className={mounted ? "" : "invisible"}>
        {resolvedTheme === "dark" ? <IconSun /> : <IconMoon />}
      </span>
    </button>
  );
}
