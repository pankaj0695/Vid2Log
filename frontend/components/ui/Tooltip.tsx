/** Lightweight hover tooltip — CSS-only (no JS positioning/portal), so it's
 * cheap to wrap around sidebar links, tab buttons, and action buttons
 * throughout the app. Shows a short (3-5 word) plain-language description
 * of what the wrapped control does, aimed at non-technical users who won't
 * recognize words like "model" or "job" — see the sidebar/tab/button copy
 * in lib/copy.ts for the actual text.
 *
 * `side` controls which edge the tooltip pops out from; default "top" suits
 * most buttons, sidebar links use "right" since the tooltip would otherwise
 * collide with the rail's own edge.
 *
 * Colors come from the dedicated `--color-tooltip-bg/fg` token pair rather
 * than ink/surface — see the note beside them in app/globals.css; those two
 * are both #ffffff in light mode, which rendered this white-on-white.
 *
 * Keyboard reveal deliberately keys off `:focus-visible` (via `has()`) and
 * NOT `:focus-within`. A mouse click focuses the wrapped control, so
 * `:focus-within` left the tooltip stuck on screen after every click on a
 * tab or button — it would sit there until focus moved elsewhere.
 * `:focus-visible` only matches focus the browser judges should be shown to
 * a keyboard user, so tabbing to a control still reveals its tooltip while
 * clicking one does not. */
export function Tooltip({
  label,
  children,
  side = "top",
  wrapperClassName = "inline-flex",
}: {
  label: string;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  wrapperClassName?: string;
}) {
  const posClasses = {
    top: "bottom-full left-1/2 mb-2 -translate-x-1/2",
    right: "left-full top-1/2 ml-2 -translate-y-1/2",
    bottom: "top-full left-1/2 mt-2 -translate-x-1/2",
    left: "right-full top-1/2 mr-2 -translate-y-1/2",
  }[side];

  return (
    <span className={`group/tooltip relative ${wrapperClassName}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none invisible absolute z-[200] whitespace-nowrap rounded-md bg-tooltip-bg px-2.5 py-1.5 text-xs font-medium text-tooltip-fg opacity-0 shadow-lg transition-[opacity,visibility] duration-150 delay-300 group-hover/tooltip:visible group-hover/tooltip:opacity-100 group-has-[:focus-visible]/tooltip:visible group-has-[:focus-visible]/tooltip:opacity-100 ${posClasses}`}
      >
        {label}
      </span>
    </span>
  );
}
