"use client";

import { useState } from "react";

/**
 * Small, dependency-free SVG chart primitives for the dark "dithered" theme.
 * No charting library — everything here is a plain <svg> sized by its
 * container, so there's no client-bundle cost and no version to keep in
 * sync. Each component takes plain data (numbers/labels) and does its own
 * scaling; none of them fetch data themselves.
 *
 * Colors: semantic tones (primary/secondary/success/warning/danger) come
 * from the CSS custom properties in globals.css via Tailwind's `stroke-*`
 * `/fill-*` utilities, so they automatically track the theme. Multi-series
 * charts (more categories than we have semantic tones for) use CATEGORY_
 * PALETTE, a fixed qualitative palette tuned for contrast on the dark bg.
 */

export const CATEGORY_PALETTE = [
  "#2dd4bf", // teal
  "#38bdf8", // sky
  "#fbbf24", // amber
  "#f87171", // rose
  "#a78bfa", // violet
  "#34d399", // emerald
  "#f472b6", // pink
  "#60a5fa", // blue
];

function paletteColor(i: number): string {
  return CATEGORY_PALETTE[i % CATEGORY_PALETTE.length];
}

/* ── Sparkline ─────────────────────────────────────────────────────────── */

export function Sparkline({
  data,
  width = 160,
  height = 40,
  color = "var(--color-primary)",
  filled = true,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  filled?: boolean;
}) {
  if (data.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const points = data.map((v, i) => [i * stepX, height - ((v - min) / range) * height]);
  const linePath = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${width},${height} L0,${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" aria-hidden="true">
      {filled && <path d={areaPath} fill={color} opacity={0.14} />}
      <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** "+12% this week" / "-16 vs last week" style chip, colored by sign. */
export function TrendChip({ value, suffix = "", label }: { value: number; suffix?: string; label?: string }) {
  const positive = value >= 0;
  const tone = positive ? "text-success" : "text-danger";
  const bg = positive ? "bg-success-tint" : "bg-danger-tint";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone} ${bg}`}>
      <span aria-hidden="true">{positive ? "↗" : "↘"}</span>
      {positive ? "+" : ""}
      {value}
      {suffix}
      {label ? ` ${label}` : ""}
    </span>
  );
}

/* ── Vertical bar chart ───────────────────────────────────────────────── */

export function BarChart({
  data,
  height = 180,
}: {
  data: { label: string; value: number; color?: string }[];
  height?: number;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="flex w-full items-end gap-2 overflow-hidden" style={{ height }}>
      {data.map((d, i) => (
        <div key={d.label} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
          <span className="font-mono text-xs text-neutral-500">{d.value}</span>
          <div
            className="w-full rounded-t-md transition-[height]"
            style={{
              height: `${Math.max(4, (d.value / max) * (height - 28))}px`,
              backgroundColor: d.color ?? paletteColor(i),
            }}
            title={`${d.label}: ${d.value}`}
          />
          <span className="w-full truncate text-center text-xs text-neutral-500">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Horizontal ranked bar chart (e.g. SPM pattern support) ──────────────── */

export function HorizontalBarChart({
  data,
}: {
  data: { label: string; value: number; hint?: string }[];
}) {
  const max = Math.max(...data.map((d) => d.value), 1e-9);
  return (
    <div className="space-y-3">
      {data.map((d, i) => (
        <div key={i}>
          {/* Label gets the full row width and wraps instead of truncating —
              pattern labels (e.g. "A → B → C → D") can be too long for a
              single line, and cropping them defeats the point of showing
              the pattern at all. */}
          <div className="mb-1 flex items-start justify-between gap-3 text-xs text-neutral-500">
            <span className="break-words font-mono text-text">{d.label}</span>
            {d.hint && <span className="shrink-0 font-mono">{d.hint}</span>}
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, backgroundColor: paletteColor(i) }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Diverging bar chart (e.g. DSM group A vs group B) ───────────────────── */

export function DivergingBarChart({
  data,
  aLabel = "Group A",
  bLabel = "Group B",
}: {
  data: { label: string; diff: number }[]; // diff in [-1, 1]; positive => A
  aLabel?: string;
  bLabel?: string;
}) {
  const maxAbs = Math.max(...data.map((d) => Math.abs(d.diff)), 1e-9);
  return (
    <div>
      <div className="mb-3 flex items-center justify-end gap-4 text-xs text-neutral-500">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-primary" /> {aLabel}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-secondary" /> {bLabel}
        </span>
      </div>
      <div className="space-y-3">
        {data.map((d, i) => {
          const pct = (Math.abs(d.diff) / maxAbs) * 50; // half-width max
          const positive = d.diff >= 0;
          return (
            // Label sits on its own full-width line above the bar instead
            // of a fixed-width side column — a side column forces long
            // pattern labels ("A → B → C → D") to truncate; a full-width
            // line lets them wrap instead.
            <div key={i}>
              <div className="mb-1 flex items-start justify-between gap-3 text-xs">
                <span className="break-words font-mono text-text">{d.label}</span>
                <span className="shrink-0 font-mono text-neutral-500">
                  {positive ? "+" : ""}
                  {(d.diff * 100).toFixed(0)}pp
                </span>
              </div>
              <div className="relative h-2 w-full rounded-full bg-neutral-100">
                <div className="absolute inset-y-0 left-1/2 w-px bg-neutral-300" />
                <div
                  className={`absolute inset-y-0 rounded-full ${positive ? "bg-primary" : "bg-secondary"}`}
                  style={
                    positive
                      ? { left: "50%", width: `${pct}%` }
                      : { right: "50%", width: `${pct}%` }
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Donut chart ──────────────────────────────────────────────────────── */

export function DonutChart({
  data,
  size = 160,
  strokeWidth = 20,
  centerLabel,
  centerValue,
}: {
  data: { label: string; value: number; color?: string }[];
  size?: number;
  strokeWidth?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--color-neutral-100)" strokeWidth={strokeWidth} />
        {data.map((d, i) => {
          const frac = d.value / total;
          const dash = frac * circumference;
          const el = (
            <circle
              key={d.label}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={d.color ?? paletteColor(i)}
              strokeWidth={strokeWidth}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              strokeLinecap={data.length === 1 ? "butt" : "round"}
            />
          );
          offset += dash;
          return el;
        })}
        {(centerLabel || centerValue) && (
          <>
            {centerValue && (
              <text x="50%" y="48%" textAnchor="middle" className="fill-text font-display text-2xl font-semibold">
                {centerValue}
              </text>
            )}
            {centerLabel && (
              <text x="50%" y="64%" textAnchor="middle" className="fill-neutral-500 text-xs">
                {centerLabel}
              </text>
            )}
          </>
        )}
      </svg>
      <ul className="space-y-1.5 text-sm">
        {data.map((d, i) => (
          <li key={d.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: d.color ?? paletteColor(i) }} />
            <span className="text-text">{d.label}</span>
            <span className="font-mono text-neutral-500">{((d.value / total) * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── Gantt-style scene timeline (one video's scenes over time) ───────────── */

function formatClock(totalSeconds: number): string {
  const t = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatDuration(seconds: number): string {
  const t = Math.max(0, Math.round(seconds));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  const s = t % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function GanttTimeline({
  segments,
  totalSeconds,
  height = 64,
  tickCount = 8,
}: {
  segments: { label: string; startSec: number; endSec: number; color?: string }[];
  totalSeconds: number;
  /** Bar height in px — defaults taller than the old 32px timeline so
   * individual scenes (and their hover targets) are easier to make out. */
  height?: number;
  /** How many evenly-spaced time labels to show on the axis below the bar. */
  tickCount?: number;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const classNames = Array.from(new Set(segments.map((s) => s.label)));
  const colorFor = (label: string) => segments.find((s) => s.label === label)?.color ?? paletteColor(classNames.indexOf(label));

  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => (totalSeconds * i) / tickCount);
  const active = hovered !== null ? segments[hovered] : null;
  const activeMidPct = active ? (((active.startSec + active.endSec) / 2) / totalSeconds) * 100 : 0;
  // Clamp so the tooltip's centering transform never pushes it past the
  // container edges for segments right at the very start/end of the video.
  const tooltipLeftPct = Math.min(94, Math.max(6, activeMidPct));

  return (
    <div>
      <div className="relative">
        {active && (
          <div
            className="pointer-events-none absolute bottom-full z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-neutral-200 bg-surface px-3 py-2 text-xs shadow-lg"
            style={{ left: `${tooltipLeftPct}%` }}
          >
            <div className="flex items-center gap-1.5 font-medium text-text">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colorFor(active.label) }} />
              {active.label}
            </div>
            <div className="mt-0.5 font-mono text-neutral-500">
              {formatClock(active.startSec)} – {formatClock(active.endSec)} · {formatDuration(active.endSec - active.startSec)}
            </div>
          </div>
        )}
        <div
          className="flex w-full overflow-hidden rounded-lg border border-neutral-200"
          style={{ height }}
        >
          {segments.map((s, i) => {
            const widthPct = ((s.endSec - s.startSec) / totalSeconds) * 100;
            return (
              <div
                key={i}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered((h) => (h === i ? null : h))}
                style={{
                  width: `${Math.max(0.3, widthPct)}%`,
                  backgroundColor: colorFor(s.label),
                  filter: hovered !== null && hovered !== i ? "brightness(0.55)" : "brightness(1)",
                }}
                className="h-full cursor-pointer border-r border-bg/40 transition-[filter] last:border-r-0"
              />
            );
          })}
        </div>
        {/* Time axis */}
        <div className="relative mt-1.5 h-4 text-xs text-neutral-500">
          {ticks.map((t, i) => (
            <span
              key={i}
              className="absolute -translate-x-1/2 font-mono first:translate-x-0 last:-translate-x-full"
              style={{ left: `${(t / totalSeconds) * 100}%` }}
            >
              {formatClock(t)}
            </span>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-neutral-500">
        {classNames.map((label) => (
          <span key={label} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colorFor(label) }} />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
