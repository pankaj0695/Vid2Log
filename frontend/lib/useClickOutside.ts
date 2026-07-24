"use client";

import { useEffect } from "react";

/** Closes a menu/popover on any click outside `ref`'s element, based on DOM
 * containment (`ref.current.contains(event.target)`) rather than a
 * full-viewport overlay div with a z-index high enough to sit on top of
 * everything — the overlay approach is fragile on pages with their own
 * positioned/stacking-context content (the landing page has several), where
 * some other element can end up painted above the catcher and swallow the
 * click before it ever reaches it. Containment-based detection doesn't care
 * about paint order at all, so it isn't sensitive to that.
 *
 * Uses `mousedown` (fires before `click`) rather than `click` — the more
 * conventional choice for this pattern, though moot here in practice since
 * the listener only attaches once React has already committed the DOM
 * update that opened the menu, well after the original opening click has
 * finished dispatching. */
export function useClickOutside<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  onOutside: () => void,
  enabled: boolean
) {
  useEffect(() => {
    if (!enabled) return;

    function handlePointerDown(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onOutside();
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [enabled, ref, onOutside]);
}
