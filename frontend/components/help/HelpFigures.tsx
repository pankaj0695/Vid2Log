/**
 * Wireframe diagrams for the /help page.
 *
 * These are deliberately schematic rather than screenshots. A screenshot goes
 * stale the moment a button moves and can't adapt to the light/dark themes;
 * these are drawn from the same CSS custom properties as the real UI (see
 * app/globals.css), so they re-colour with the theme and never drift out of
 * date in a way that misleads.
 *
 * Numbered badges in a figure correspond to the numbered steps in that
 * section's text — "3" in the list is "3" in the picture.
 *
 * Everything is plain inline SVG with no external dependency. `vector-effect`
 * is avoided; instead all strokes are 1–1.5 units on a fixed viewBox that
 * scales down, which stays crisp at the sizes actually used here.
 */

const W = 520;

/* ── primitives ────────────────────────────────────────────────────────── */

function Frame({ children, height }: { children: React.ReactNode; height: number }) {
  return (
    <>
      <rect
        x={0.75}
        y={0.75}
        width={W - 1.5}
        height={height - 1.5}
        rx={10}
        fill="var(--color-surface)"
        stroke="var(--color-neutral-200)"
        strokeWidth={1.5}
      />
      {children}
    </>
  );
}

function Panel({
  x,
  y,
  w,
  h,
  tone = "surface",
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  tone?: "surface" | "muted" | "accent";
}) {
  const fill =
    tone === "muted"
      ? "var(--color-neutral-100)"
      : tone === "accent"
        ? "var(--color-primary-tint)"
        : "var(--color-surface)";
  return (
    <rect x={x} y={y} width={w} height={h} rx={7} fill={fill} stroke="var(--color-neutral-200)" />
  );
}

/** A line of "text". Width is a fraction so blocks read as prose, not data. */
function Line({ x, y, w, strong }: { x: number; y: number; w: number; strong?: boolean }) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={strong ? 7 : 5}
      rx={2.5}
      fill={strong ? "var(--color-neutral-400)" : "var(--color-neutral-300)"}
    />
  );
}

function Label({
  x,
  y,
  children,
  anchor = "start",
  dim,
  size = 11,
}: {
  x: number;
  y: number;
  children: React.ReactNode;
  anchor?: "start" | "middle" | "end";
  dim?: boolean;
  size?: number;
}) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={size}
      fontFamily="ui-sans-serif, system-ui, sans-serif"
      fill={dim ? "var(--color-neutral-500)" : "var(--color-text)"}
    >
      {children}
    </text>
  );
}

function Btn({
  x,
  y,
  w = 84,
  h = 22,
  children,
  variant = "primary",
}: {
  x: number;
  y: number;
  w?: number;
  h?: number;
  children: React.ReactNode;
  variant?: "primary" | "outline";
}) {
  const isPrimary = variant === "primary";
  return (
    <>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={6}
        fill={isPrimary ? "var(--color-primary)" : "transparent"}
        stroke={isPrimary ? "none" : "var(--color-neutral-300)"}
      />
      <text
        x={x + w / 2}
        y={y + h / 2 + 3.5}
        textAnchor="middle"
        fontSize={10}
        fontWeight={600}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill={isPrimary ? "var(--color-ink)" : "var(--color-neutral-600)"}
      >
        {children}
      </text>
    </>
  );
}

/** Lays a row of items out left-to-right, returning each one's x position and
 * width. Positions are derived rather than accumulated into a mutable
 * variable during render — see the react-hooks/immutability lint rule. */
function runLengths(widths: number[], startX: number, gap: number): { x: number; w: number }[] {
  return widths.map((w, i) => ({
    x: startX + widths.slice(0, i).reduce((sum, prev) => sum + prev + gap, 0),
    w,
  }));
}

function Tabs({ x, y, items, active = 0 }: { x: number; y: number; items: string[]; active?: number }) {
  const boxes = runLengths(
    items.map((t) => t.length * 5.4 + 20),
    x,
    4,
  );
  return (
    <>
      {items.map((t, i) => (
        <g key={`${t}-${i}`}>
          <rect
            x={boxes[i].x}
            y={y}
            width={boxes[i].w}
            height={20}
            rx={6}
            fill={i === active ? "var(--color-primary-tint)" : "transparent"}
          />
          <text
            x={boxes[i].x + boxes[i].w / 2}
            y={y + 13.5}
            textAnchor="middle"
            fontSize={9.5}
            fontWeight={600}
            fontFamily="ui-sans-serif, system-ui, sans-serif"
            fill={i === active ? "var(--color-primary-hover)" : "var(--color-neutral-500)"}
          >
            {t}
          </text>
        </g>
      ))}
    </>
  );
}

/** The numbered badge that ties a spot in the diagram to a numbered step. */
function Callout({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <>
      <circle cx={x} cy={y} r={9} fill="var(--color-primary)" />
      <text
        x={x}
        y={y + 3.7}
        textAnchor="middle"
        fontSize={10.5}
        fontWeight={700}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill="var(--color-ink)"
      >
        {n}
      </text>
    </>
  );
}

function Thumb({ x, y, s = 30, tone = 0 }: { x: number; y: number; s?: number; tone?: number }) {
  const fills = ["var(--color-neutral-200)", "var(--color-neutral-300)", "var(--color-primary-tint)"];
  return <rect x={x} y={y} width={s} height={s} rx={4} fill={fills[tone % fills.length]} />;
}

function Figure({ height, children, title }: { height: number; children: React.ReactNode; title: string }) {
  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      className="h-auto w-full"
      role="img"
      aria-label={title}
      preserveAspectRatio="xMidYMid meet"
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

/* ── figures ───────────────────────────────────────────────────────────── */

function WorkflowFigure() {
  const steps = ["Create\nactions", "Train", "Process\nvideo", "Video\nlogs", "Analytics"];
  return (
    <Figure height={118} title="The five stages of a Vid2Log study, left to right">
      {steps.map((s, i) => {
        const x = 8 + i * 102;
        const lines = s.split("\n");
        return (
          <g key={`${s}-${i}`}>
            <rect
              x={x}
              y={30}
              width={88}
              height={54}
              rx={8}
              fill={i < 2 ? "var(--color-primary-tint)" : "var(--color-surface)"}
              stroke={i < 2 ? "var(--color-primary)" : "var(--color-neutral-200)"}
            />
            <Callout x={x + 12} y={30} n={i + 1} />
            {lines.map((ln, j) => (
              <text
                key={`${ln}-${j}`}
                x={x + 44}
                y={54 + j * 13 - (lines.length - 1) * 6.5}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fontFamily="ui-sans-serif, system-ui, sans-serif"
                fill="var(--color-text)"
              >
                {ln}
              </text>
            ))}
            {i < steps.length - 1 && (
              <path
                d={`M${x + 90} 57 L${x + 100} 57`}
                stroke="var(--color-neutral-400)"
                strokeWidth={1.5}
                markerEnd="url(#hArrow)"
              />
            )}
          </g>
        );
      })}
      <defs>
        <marker id="hArrow" markerWidth={6} markerHeight={6} refX={5} refY={3} orient="auto">
          <path d="M0 0 L6 3 L0 6 z" fill="var(--color-neutral-400)" />
        </marker>
      </defs>
      <Label x={8} y={104} dim size={10}>
        Once per study
      </Label>
      <Label x={218} y={104} dim size={10}>
        Repeat for every new recording
      </Label>
    </Figure>
  );
}

function DashboardFigure() {
  return (
    <Figure height={168} title="Dashboard: stat cards above recent recordings and quick actions">
      <Frame height={168}>
        <Label x={16} y={26}>
          Dashboard
        </Label>
        <Tabs x={14} y={36} items={["Overview", "Detectors", "Activity"]} />
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <Panel x={14 + i * 124} y={66} w={112} h={38} tone="muted" />
            <Line x={24 + i * 124} y={76} w={44} />
            <Line x={24 + i * 124} y={87} w={26} strong />
          </g>
        ))}
        <Panel x={14} y={114} w={330} h={44} />
        <Label x={24} y={130} size={10} dim>
          Recent recordings
        </Label>
        <Line x={24} y={140} w={180} />
        <Line x={24} y={149} w={140} />
        <Panel x={354} y={114} w={152} h={44} />
        <Label x={364} y={130} size={10} dim>
          Quick actions
        </Label>
        <Btn x={364} y={136} w={132} h={16} variant="outline">
          Process a video
        </Btn>
      </Frame>
    </Figure>
  );
}

function DiscoverFigure() {
  return (
    <Figure height={186} title="Create actions: the discover form, with the four numbered steps">
      <Frame height={186}>
        <Label x={16} y={26}>
          Create actions
        </Label>
        <Tabs x={14} y={36} items={["Discover", "Saved action sets"]} />
        <Panel x={14} y={68} w={492} h={104} />

        <Panel x={28} y={80} w={464} h={26} tone="muted" />
        <Label x={40} y={97} size={10} dim>
          Choose a screen recording…
        </Label>
        <Callout x={28} y={80} n={1} />

        <Label x={40} y={124} size={9.5} dim>
          Sampling FPS
        </Label>
        <Panel x={28} y={128} w={210} h={22} tone="muted" />
        <Label x={40} y={143} size={10}>
          2
        </Label>
        <Callout x={28} y={128} n={2} />

        <Label x={294} y={124} size={9.5} dim>
          Minimum cluster size
        </Label>
        <Panel x={282} y={128} w={210} h={22} tone="muted" />
        <Label x={294} y={143} size={10}>
          5
        </Label>
        <Callout x={282} y={128} n={3} />

        <Btn x={396} y={158} w={96} h={20}>
          Discover actions
        </Btn>
        <Callout x={396} y={158} n={4} />
      </Frame>
    </Figure>
  );
}

function ReviewFigure() {
  return (
    <Figure height={196} title="Create actions: reviewing discovered groups, with the manage panel on the right">
      <Frame height={196}>
        <Label x={16} y={26}>
          Reviewing actions
        </Label>

        {[0, 1].map((row) => (
          <g key={row}>
            <Panel x={14} y={40 + row * 74} w={340} h={66} />
            <rect x={26} y={52 + row * 74} width={10} height={10} rx={2.5} stroke="var(--color-neutral-400)" fill="none" />
            <Panel x={44} y={48 + row * 74} w={120} h={18} tone="muted" />
            <Label x={52} y={61 + row * 74} size={9.5}>
              {row === 0 ? "Login screen" : "Search results"}
            </Label>
            {[0, 1, 2, 3, 4].map((t) => (
              <Thumb key={t} x={26 + t * 36} y={72 + row * 74} tone={t + row} />
            ))}
          </g>
        ))}
        <Callout x={44} y={48} n={1} />
        <Callout x={26} y={52 + 74} n={2} />

        <Panel x={366} y={40} w={140} h={70} />
        <Label x={376} y={56} size={9.5} dim>
          Manage actions
        </Label>
        <Btn x={376} y={62} w={120} h={18} variant="outline">
          + Add new action
        </Btn>
        <Btn x={376} y={84} w={120} h={18} variant="outline">
          Merge selected
        </Btn>

        <Panel x={366} y={120} w={140} h={62} />
        <Panel x={376} y={130} w={120} h={18} tone="muted" />
        <Label x={384} y={143} size={9} dim>
          Action set name
        </Label>
        <Btn x={376} y={154} w={120} h={20}>
          Save action set
        </Btn>
        <Callout x={376} y={154} n={5} />
      </Frame>
    </Figure>
  );
}

function TrainFigure() {
  return (
    <Figure height={182} title="Train: import an action set, name the detector, start training">
      <Frame height={182}>
        <Label x={16} y={26}>
          Train a detector
        </Label>
        <Tabs x={14} y={36} items={["Train a detector", "Training sessions"]} />

        <Panel x={14} y={68} w={492} h={52} />
        <Label x={26} y={84} size={10} dim>
          Dataset
        </Label>
        <Btn x={26} y={90} w={92} h={20} variant="outline">
          Import action set
        </Btn>
        <Callout x={26} y={90} n={1} />
        {[0, 1, 2].map((i) => (
          <g key={i}>
            <Panel x={140 + i * 122} y={90} w={112} h={20} tone="muted" />
            <Label x={150 + i * 122} y={104} size={9}>
              {["Login · 24", "Search · 31", "Checkout · 19"][i]}
            </Label>
          </g>
        ))}

        <Panel x={14} y={128} w={492} h={44} />
        <Label x={26} y={144} size={10} dim>
          Detector name
        </Label>
        <Panel x={26} y={148} w={240} h={20} tone="muted" />
        <Callout x={26} y={148} n={2} />
        <Btn x={410} y={148} w={82} h={20}>
          Start training
        </Btn>
        <Callout x={410} y={148} n={3} />
      </Frame>
    </Figure>
  );
}

function MetricsFigure() {
  const cells = [
    [92, 4, 4],
    [6, 88, 6],
    [3, 9, 88],
  ];
  return (
    <Figure height={196} title="Detector results: accuracy rows and a confusion matrix">
      <Frame height={196}>
        <Label x={16} y={26}>
          Detector results
        </Label>

        {["CNN-only", "OCR text-only", "Combined"].map((r, i) => (
          <g key={r}>
            <Panel x={14} y={38 + i * 30} w={230} h={24} tone={i === 2 ? "accent" : "surface"} />
            <Label x={26} y={54 + i * 30} size={10} dim={i !== 2}>
              {r}
            </Label>
            <Label x={228} y={54 + i * 30} size={10} anchor="end">
              {["91.2%", "78.4%", "96.4%"][i]}
            </Label>
          </g>
        ))}
        <Label x={14} y={144} size={9.5} dim>
          Combined is what actually runs
        </Label>

        <Label x={268} y={34} size={10} dim>
          Confusion matrix
        </Label>
        {cells.map((row, r) =>
          row.map((v, c) => {
            const on = r === c;
            return (
              <g key={`${r}-${c}`}>
                <rect
                  x={286 + c * 46}
                  y={44 + r * 34}
                  width={42}
                  height={30}
                  rx={4}
                  fill={on ? "var(--color-success)" : "var(--color-danger)"}
                  opacity={on ? 0.18 + (v / 100) * 0.5 : 0.08 + (v / 100) * 0.9}
                />
                <text
                  x={307 + c * 46}
                  y={63 + r * 34}
                  textAnchor="middle"
                  fontSize={10}
                  fontFamily="ui-monospace, monospace"
                  fill="var(--color-text)"
                >
                  {v}
                </text>
              </g>
            );
          }),
        )}
        <Label x={268} y={62} size={8.5} anchor="end" dim>
          true →
        </Label>
        <Label x={286} y={162} size={9} dim>
          Diagonal: correct. Away from it: a confused pair.
        </Label>
      </Frame>
    </Figure>
  );
}

function ProcessFigure() {
  return (
    <Figure height={178} title="Process video: choose a file, a detector and a sampling rate">
      <Frame height={178}>
        <Label x={16} y={26}>
          Process a video
        </Label>
        <Tabs x={14} y={36} items={["New recording", "Recording history"]} />

        <Panel x={14} y={68} w={492} h={96} />
        <Panel x={28} y={80} w={464} h={26} tone="muted" />
        <Label x={40} y={97} size={10} dim>
          Choose a video file…
        </Label>
        <Callout x={28} y={80} n={1} />

        <Label x={40} y={124} size={9.5} dim>
          Detector
        </Label>
        <Panel x={28} y={128} w={300} h={22} tone="muted" />
        <Label x={40} y={143} size={10}>
          Use active detector
        </Label>
        <Callout x={28} y={128} n={2} />

        <Label x={384} y={124} size={9.5} dim>
          Sampling FPS
        </Label>
        <Panel x={372} y={128} w={120} h={22} tone="muted" />
        <Label x={384} y={143} size={10}>
          2
        </Label>
        <Callout x={372} y={128} n={3} />
      </Frame>
    </Figure>
  );
}

function LogsFigure() {
  const rows = [
    ["00:00", "00:05", "Login screen", "95%"],
    ["00:05", "00:12", "Search results", "91%"],
    ["00:12", "00:20", "Checkout", "88%"],
  ];
  return (
    <Figure height={172} title="Video logs: the scene table inside an expanded log">
      <Frame height={172}>
        <Label x={16} y={26}>
          Video logs
        </Label>
        <Btn x={330} y={14} w={78} h={18} variant="outline">
          CSV template
        </Btn>
        <Btn x={414} y={14} w={92} h={18} variant="outline">
          Import CSV log
        </Btn>

        <Panel x={14} y={44} w={492} h={116} />
        {["Start", "End", "Action", "Confidence"].map((h, i) => (
          <Label key={h} x={28 + i * 122} y={64} size={9.5} dim>
            {h}
          </Label>
        ))}
        <path d={`M22 70 L498 70`} stroke="var(--color-neutral-200)" strokeWidth={1} />
        {rows.map((r, ri) =>
          r.map((c, ci) => (
            <Label key={`${ri}-${ci}`} x={28 + ci * 122} y={88 + ri * 22} size={9.5}>
              {c}
            </Label>
          )),
        )}
        <Btn x={28} y={132} w={88} h={19} variant="outline">
          Download CSV
        </Btn>
      </Frame>
    </Figure>
  );
}

function SpmFigure() {
  return (
    <Figure height={162} title="Sequential patterns: recurring action sequences with their support scores">
      <Frame height={162}>
        <Label x={16} y={26}>
          Sequential patterns (SPM)
        </Label>
        <Panel x={14} y={38} w={492} h={112} />
        {["Pattern", "S-support", "I-support"].map((h, i) => (
          <Label key={h} x={28 + [0, 300, 396][i]} y={56} size={9.5} dim>
            {h}
          </Label>
        ))}
        <path d="M22 62 L498 62" stroke="var(--color-neutral-200)" strokeWidth={1} />
        {[
          [["Login", "Search"], "86%", "2.4"],
          [["Search", "Checkout"], "71%", "1.8"],
          [["Search", "Search"], "64%", "3.1"],
        ].map((row, ri) => {
          const chips = row[0] as string[];
          const boxes = runLengths(
            chips.map((c) => c.length * 5.2 + 14),
            28,
            16,
          );
          return (
            <g key={ri}>
              {chips.map((c, i) => (
                // A pattern may legitimately repeat an action, so the label
                // alone is not unique within a row; index disambiguates.
                <g key={`${c}-${i}`}>
                  <rect
                    x={boxes[i].x}
                    y={72 + ri * 26}
                    width={boxes[i].w}
                    height={16}
                    rx={4}
                    fill="var(--color-neutral-100)"
                  />
                  <text
                    x={boxes[i].x + boxes[i].w / 2}
                    y={83 + ri * 26}
                    textAnchor="middle"
                    fontSize={9}
                    fontFamily="ui-sans-serif, system-ui, sans-serif"
                    fill="var(--color-text)"
                  >
                    {c}
                  </text>
                  {i < chips.length - 1 && (
                    <text
                      x={boxes[i].x + boxes[i].w + 5}
                      y={83 + ri * 26}
                      fontSize={9}
                      fill="var(--color-neutral-400)"
                    >
                      →
                    </text>
                  )}
                </g>
              ))}
              <Label x={328} y={84 + ri * 26} size={9.5} anchor="end">
                {row[1] as string}
              </Label>
              <Label x={424} y={84 + ri * 26} size={9.5} anchor="end">
                {row[2] as string}
              </Label>
            </g>
          );
        })}
      </Frame>
    </Figure>
  );
}

function DsmFigure() {
  return (
    <Figure height={150} title="Differential patterns: two non-overlapping groups of logs, compared">
      <Frame height={150}>
        <Label x={16} y={26}>
          Differential patterns (DSM)
        </Label>
        {["Group A", "Group B"].map((g, gi) => (
          <g key={g}>
            <Panel x={14 + gi * 250} w={242} y={38} h={72} tone={gi === 0 ? "accent" : "surface"} />
            <Label x={26 + gi * 250} y={54} size={10}>
              {g}
            </Label>
            {[0, 1, 2].map((i) => (
              <g key={i}>
                <rect
                  x={26 + gi * 250}
                  y={60 + i * 15}
                  width={9}
                  height={9}
                  rx={2}
                  fill={i < 2 ? "var(--color-primary)" : "none"}
                  stroke="var(--color-neutral-400)"
                />
                <Line x={42 + gi * 250} y={62 + i * 15} w={120} />
              </g>
            ))}
          </g>
        ))}
        <Label x={260} y={128} anchor="middle" size={9.5} dim>
          A log may belong to one group only; the other list disables it
        </Label>
      </Frame>
    </Figure>
  );
}

function TimelineFigure() {
  const bars = [
    [0, 96, 0],
    [100, 150, 1],
    [254, 80, 2],
    [338, 60, 0],
    [402, 90, 1],
  ];
  return (
    <Figure height={134} title="Video timeline: each log's actions laid out along real time">
      <Frame height={134}>
        <Label x={16} y={26}>
          Video timeline
        </Label>
        {[0, 1].map((row) => (
          <g key={row}>
            <Label x={16} y={54 + row * 40} size={9.5} dim>
              {row === 0 ? "session-01" : "session-02"}
            </Label>
            {bars.map(([x, w, tone], i) => (
              <rect
                key={i}
                x={14 + (x as number) * (row === 0 ? 1 : 0.86)}
                y={60 + row * 40}
                width={(w as number) * (row === 0 ? 1 : 0.86)}
                height={18}
                rx={3}
                fill={
                  ["var(--color-primary)", "var(--color-secondary)", "var(--color-warning)"][tone as number]
                }
                opacity={0.75}
              />
            ))}
          </g>
        ))}
        <path d="M14 122 L506 122" stroke="var(--color-neutral-200)" strokeWidth={1} />
        <Label x={14} y={118} size={8.5} dim>
          0:00
        </Label>
        <Label x={506} y={118} size={8.5} dim anchor="end">
          end
        </Label>
      </Frame>
    </Figure>
  );
}

/* ── registry ──────────────────────────────────────────────────────────── */

export const HELP_FIGURES = {
  workflow: WorkflowFigure,
  dashboard: DashboardFigure,
  discover: DiscoverFigure,
  review: ReviewFigure,
  train: TrainFigure,
  metrics: MetricsFigure,
  process: ProcessFigure,
  logs: LogsFigure,
  spm: SpmFigure,
  dsm: DsmFigure,
  timeline: TimelineFigure,
} as const;
