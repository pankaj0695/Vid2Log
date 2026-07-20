"use client";

/**
 * Animated hero mockup for the landing page. Plays once on mount, stepping
 * through the three real stages of the product — train → process → analyze
 * — like a short product demo, then settles on the analytics scene as its
 * resting frame (it does not loop). Pure CSS transitions + timers, no
 * animation library: bar heights already have `transition-[height]` in
 * BarChart, so mounting values at 0 and flipping them to real numbers a beat
 * later makes them "grow" for free.
 */

import { useEffect, useState } from "react";

type Scene = "train" | "process" | "analyze";

const TRAIN_CLASSES = [
  { name: "ProblemStatement", count: 24 },
  { name: "GameWorkspace", count: 31 },
  { name: "ProductSelection", count: 19 },
];

const PROCESS_ROWS = [
  { label: "ProblemStatement", time: "0:00–0:14" },
  { label: "GameWorkspace", time: "0:14–0:52" },
  { label: "ProductSelection", time: "0:52–1:10" },
];

const ANALYTICS_BARS = [
  { label: "Mon", value: 4 },
  { label: "Tue", value: 7 },
  { label: "Wed", value: 5 },
  { label: "Thu", value: 9 },
  { label: "Fri", value: 12 },
];

const DONUT_DATA = [
  { label: "CNN", value: 78 },
  { label: "OCR fusion", value: 22 },
];

function ChromeHeader({ path }: { path: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-neutral-200 bg-surface-2 px-4 py-3">
      <span className="h-2.5 w-2.5 rounded-full bg-danger/70" />
      <span className="h-2.5 w-2.5 rounded-full bg-warning/70" />
      <span className="h-2.5 w-2.5 rounded-full bg-success/70" />
      <span className="ml-3 truncate rounded-md bg-neutral-100 px-3 py-1 font-mono text-xs text-neutral-500">
        vid2log / {path}
      </span>
    </div>
  );
}

function SceneBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary-tint px-2.5 py-1 font-mono text-xs text-primary-hover">
      <span className="h-1.5 w-1.5 rounded-full bg-primary" /> {label}
    </span>
  );
}

function TrainScene({ visibleClasses, progress }: { visibleClasses: number; progress: number }) {
  const epoch = Math.round((progress / 100) * 20);
  return (
    <div className="animate-scene-in p-5">
      <div className="mb-4 flex items-center justify-between">
        <SceneBadge label="TRAINING" />
        <span className="text-xs text-neutral-500">3 classes</span>
      </div>

      <div className="space-y-2">
        {TRAIN_CLASSES.map((c, i) => (
          <div
            key={c.name}
            className={`flex items-center justify-between rounded-lg border border-neutral-200 px-3 py-2 text-sm transition-opacity duration-500 ${
              i < visibleClasses ? "animate-row-in opacity-100" : "opacity-0"
            }`}
          >
            <span className="text-text">{c.name}</span>
            <span className="font-mono text-xs text-neutral-500">{c.count} images</span>
          </div>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-neutral-200 p-3">
        <div className="mb-2 flex items-center justify-between font-mono text-xs text-neutral-500">
          <span>Epoch {epoch}/20</span>
          <span>{progress}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-[1600ms] ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
        {progress === 100 && (
          <p className="animate-row-in mt-3 text-sm text-success">✓ Model trained — 96.4% test accuracy</p>
        )}
      </div>
    </div>
  );
}

function ProcessScene({ visibleRows, progress }: { visibleRows: number; progress: number }) {
  return (
    <div className="animate-scene-in p-5">
      <div className="mb-4 flex items-center justify-between">
        <SceneBadge label="PROCESSING" />
        <span className="text-xs text-neutral-500">4 workers online</span>
      </div>

      <div className="rounded-lg border border-neutral-200 p-3">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="truncate text-text">onboarding_flow_03.mp4</span>
          <span className="font-mono text-xs text-neutral-500">{progress}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-100">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-[900ms] ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <ul className="mt-4 divide-y divide-neutral-100 rounded-lg border border-neutral-200">
        {PROCESS_ROWS.map((row, i) => (
          <li
            key={row.label}
            className={`flex items-center justify-between px-3 py-2 text-sm transition-opacity duration-500 ${
              i < visibleRows ? "animate-row-in opacity-100" : "opacity-0"
            }`}
          >
            <span className="truncate text-text">{row.label}</span>
            <span className="shrink-0 font-mono text-xs text-neutral-500">{row.time}</span>
          </li>
        ))}
      </ul>

      {visibleRows === PROCESS_ROWS.length && (
        <p className="animate-row-in mt-3 text-sm text-success">✓ 42 scenes detected</p>
      )}
    </div>
  );
}

function AnalyzeScene({ ready }: { ready: boolean }) {
  const bars = ANALYTICS_BARS.map((b) => ({ ...b, value: ready ? b.value : 0 }));
  const donut = DONUT_DATA.map((d) => ({ ...d, value: ready ? d.value : 0 }));
  return (
    <div className="animate-scene-in p-5">
      <div className="mb-4 flex items-center justify-between">
        <SceneBadge label="ANALYTICS" />
        <span className="text-xs text-neutral-500">6 logs analyzed</span>
      </div>

      <div className="rounded-lg border border-neutral-200 p-3">
        <p className="mb-2 text-xs text-neutral-500">Videos processed this week</p>
        <div className="flex items-end gap-2" style={{ height: 110 }}>
          {bars.map((b, i) => (
            <div key={b.label} className="flex flex-1 flex-col items-center justify-end gap-1.5">
              <span className="font-mono text-xs text-neutral-500">{b.value || ""}</span>
              <div
                className="w-full rounded-t-md bg-primary transition-[height] duration-[1200ms] ease-out"
                style={{ height: `${Math.max(4, (b.value / 12) * 82)}px` }}
              />
              <span className="w-full truncate text-center text-xs text-neutral-500">{b.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-center gap-4 rounded-lg border border-neutral-200 p-3">
        <svg width={64} height={64} viewBox="0 0 64 64" className="shrink-0" aria-hidden="true">
          <circle cx={32} cy={32} r={24} fill="none" stroke="var(--color-neutral-100)" strokeWidth={10} />
          {donut[0].value > 0 && (
            <circle
              cx={32}
              cy={32}
              r={24}
              fill="none"
              stroke="var(--color-primary)"
              strokeWidth={10}
              strokeDasharray={`${(donut[0].value / 100) * 2 * Math.PI * 24} ${2 * Math.PI * 24}`}
              transform="rotate(-90 32 32)"
              strokeLinecap="round"
              className="transition-all duration-[900ms] ease-out"
            />
          )}
        </svg>
        <ul className="space-y-1 text-xs">
          <li className="flex items-center gap-1.5 text-neutral-500">
            <span className="h-2 w-2 rounded-full bg-primary" /> CNN classification
          </li>
          <li className="flex items-center gap-1.5 text-neutral-500">
            <span className="h-2 w-2 rounded-full bg-neutral-300" /> OCR fusion
          </li>
        </ul>
      </div>
    </div>
  );
}

export function HeroPreview() {
  const [scene, setScene] = useState<Scene>("train");
  const [visibleClasses, setVisibleClasses] = useState(0);
  const [trainProgress, setTrainProgress] = useState(0);
  const [processProgress, setProcessProgress] = useState(0);
  const [visibleRows, setVisibleRows] = useState(0);
  const [analyticsReady, setAnalyticsReady] = useState(false);

  useEffect(() => {
    // No extra "already scheduled" ref guard here: in dev, React StrictMode
    // mounts, runs this effect, cleans it up, then mounts again — since the
    // cleanup below clears every timer from that first pass, the second
    // (real) pass schedules a fresh, correct sequence. A guard that skips
    // re-scheduling on the second pass would instead leave the whole
    // animation dead in dev, since the first pass's timers get cleared and
    // nothing replaces them.
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));

    // Scene 1 — train
    TRAIN_CLASSES.forEach((_, i) => at(300 + i * 300, () => setVisibleClasses(i + 1)));
    at(1300, () => setTrainProgress(100));

    // Scene 2 — process
    at(3100, () => setScene("process"));
    at(3500, () => setProcessProgress(100));
    PROCESS_ROWS.forEach((_, i) => at(3900 + i * 450, () => setVisibleRows(i + 1)));

    // Scene 3 — analyze (resting frame, does not loop back)
    at(6700, () => setScene("analyze"));
    at(7100, () => setAnalyticsReady(true));

    return () => timers.forEach(clearTimeout);
  }, []);

  const path = scene === "train" ? "train" : scene === "process" ? "process" : "analytics";

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-surface shadow-2xl shadow-black/40">
      <ChromeHeader path={path} />
      {scene === "train" && <TrainScene visibleClasses={visibleClasses} progress={trainProgress} />}
      {scene === "process" && <ProcessScene visibleRows={visibleRows} progress={processProgress} />}
      {scene === "analyze" && <AnalyzeScene ready={analyticsReady} />}
    </div>
  );
}
