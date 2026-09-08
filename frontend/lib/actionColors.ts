/**
 * Stable, high-contrast colours for action labels.
 *
 * Two properties matter here, and they pull against each other:
 *
 *  1. The SAME action must look the same in every log, so timelines can be
 *     compared by eye. That rules out colouring by position within one log
 *     (index 0 = teal), which is what this replaced: "walking" would be teal
 *     in the first log and amber in the next.
 *
 *  2. DIFFERENT actions on screen together must be easy to tell apart. That
 *     rules out plain hashing, which happily gives two actions the same slot.
 *
 * The resolution: a label's colour is chosen by hashing its name (property 1),
 * and `buildActionStyleMap` then resolves any collisions across the whole set
 * of labels on screen (property 2). Because the map is built once from every
 * timeline being shown, a given action is identical across all of them.
 *
 * Colours are mid-tone on purpose: the app themes both light (#f8fafc) and
 * dark (#070c13), so anything too pale or too deep would vanish on one of
 * them.
 *
 * Beyond ~10 categories, colour alone stops working — human colour
 * discrimination for categorical data runs out, and any 20-colour palette has
 * pairs that look alike. So the palette is 10 well-separated hues crossed with
 * 3 fill patterns (solid / stripes / dots), giving 30 combinations that stay
 * distinguishable because they differ in more than hue.
 */

/** Ten hues, ordered so that the closest pair (amber/orange) sits as far apart
 *  in the sequence as possible — small label sets only ever draw from the
 *  front, so they get the most distinct subset. */
export const ACTION_PALETTE = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#22c55e", // green
  "#f59e0b", // amber
  "#a855f7", // purple
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#64748b", // slate
] as const;

/** 0 = solid, 1 = diagonal stripes, 2 = dots. */
export type ActionPattern = 0 | 1 | 2;

export type ActionStyle = {
  color: string;
  pattern: ActionPattern;
};

const PATTERN_COUNT = 3;
const TOTAL_SLOTS = ACTION_PALETTE.length * PATTERN_COUNT;

/**
 * Labels are matched case- and whitespace-insensitively, so "Walking",
 * "walking" and " walking " are one action. CSV imports make this common.
 */
export function normalizeActionLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

/** FNV-1a. Small, dependency-free, and stable across runs — unlike anything
 *  built on object key order or insertion order. */
function hashLabel(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix a hex colour toward black (amount < 0) or white (amount > 0). */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mixTo = amount > 0 ? 255 : 0;
  const t = Math.abs(amount);
  const ch = (shift: number) => {
    const v = (n >> shift) & 0xff;
    return Math.round(v + (mixTo - v) * t);
  };
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

/** Once the ten hues run out they have to be reused, so each later tier also
 *  shifts luminance. A tier-1 action is a DARK striped green rather than the
 *  same green as its tier-0 neighbour — differing in two dimensions, not one,
 *  which is what keeps them apart at a glance. */
const TIER_SHADE: Record<ActionPattern, number> = { 0: 0, 1: -0.42, 2: 0.4 };

function styleForSlot(slot: number): ActionStyle {
  const s = slot % TOTAL_SLOTS;
  const base = ACTION_PALETTE[s % ACTION_PALETTE.length];
  // Patterns only start once every colour has been used once, so a handful
  // of actions render as clean solid bars.
  const pattern = Math.floor(s / ACTION_PALETTE.length) as ActionPattern;
  return {
    color: pattern === 0 ? base : shade(base, TIER_SHADE[pattern]),
    pattern,
  };
}

/** A label's first-choice slot. Always in the solid tier, so a view with ten
 *  or fewer actions never shows a pattern. */
function preferredSlot(normalized: string): number {
  return hashLabel(normalized) % ACTION_PALETTE.length;
}

/**
 * Slots to try, in order: every colour in the solid tier first (starting at
 * the preferred one), then the same sweep in each patterned tier. This is what
 * keeps patterns out of small label sets — they only appear once all ten
 * colours are spoken for.
 */
function probeOrder(preferred: number): number[] {
  const order: number[] = [];
  for (let tier = 0; tier < PATTERN_COUNT; tier++) {
    for (let i = 0; i < ACTION_PALETTE.length; i++) {
      order.push(tier * ACTION_PALETTE.length + ((preferred + i) % ACTION_PALETTE.length));
    }
  }
  return order;
}

/**
 * Colour for a single label with no knowledge of the others. Used as a
 * fallback when there's no shared map — stable, but two labels can collide.
 */
export function actionStyle(label: string): ActionStyle {
  return styleForSlot(preferredSlot(normalizeActionLabel(label)));
}

/** Convenience for charts that only take a colour string. */
export function actionColor(label: string): string {
  return actionStyle(label).color;
}

/**
 * Assign every label a distinct style, keeping each label's hashed slot where
 * possible so colours stay stable as logs are added or removed.
 *
 * Labels are sorted first so the outcome depends only on WHICH labels are
 * present, never on the order they arrived in.
 */
export function buildActionStyleMap(labels: Iterable<string>): Map<string, ActionStyle> {
  const unique = Array.from(new Set(Array.from(labels, normalizeActionLabel))).sort();

  const taken = new Set<number>();
  const slotOf = new Map<string, number>();

  // Pass 1: everyone who can have their preferred colour gets it.
  for (const label of unique) {
    const preferred = preferredSlot(label);
    if (!taken.has(preferred)) {
      taken.add(preferred);
      slotOf.set(label, preferred);
    }
  }

  // Pass 2: whoever lost a collision takes the first free slot in probe order,
  // exhausting solid colours before falling back to patterned ones.
  for (const label of unique) {
    if (slotOf.has(label)) continue;
    const free = probeOrder(preferredSlot(label)).find((s) => !taken.has(s));
    // With more than TOTAL_SLOTS labels every slot is taken and styles must
    // repeat; the preferred slot is as good a duplicate as any.
    const slot = free ?? preferredSlot(label);
    taken.add(slot);
    slotOf.set(label, slot);
  }

  const out = new Map<string, ActionStyle>();
  for (const [label, slot] of slotOf) out.set(label, styleForSlot(slot));
  return out;
}

/** Look a label up in a map built by `buildActionStyleMap`, falling back to
 *  the uncoordinated hash if it isn't there. */
export function lookupActionStyle(
  map: Map<string, ActionStyle> | undefined,
  label: string,
): ActionStyle {
  return map?.get(normalizeActionLabel(label)) ?? actionStyle(label);
}

/**
 * CSS for a swatch or bar. The pattern overlay is drawn in translucent
 * black/white so it reads on every hue in the palette without needing a
 * second colour per entry.
 */
export function actionStyleCss(style: ActionStyle): React.CSSProperties {
  const base: React.CSSProperties = { backgroundColor: style.color };
  // Tier 1 is a darkened hue, so its stripes are light; tier 2 is a lightened
  // hue, so its dots are dark. Each overlay is chosen to contrast with the
  // fill it sits on rather than with the page.
  if (style.pattern === 1) {
    return {
      ...base,
      backgroundImage:
        "repeating-linear-gradient(45deg, rgba(255,255,255,0.45) 0 3px, rgba(255,255,255,0) 3px 7px)",
    };
  }
  if (style.pattern === 2) {
    return {
      ...base,
      backgroundImage: "radial-gradient(rgba(0,0,0,0.42) 1.4px, rgba(0,0,0,0) 1.5px)",
      backgroundSize: "6px 6px",
    };
  }
  return base;
}
