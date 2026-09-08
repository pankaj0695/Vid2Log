/**
 * Reading, repairing and writing scene-log CSVs, entirely client side.
 *
 * WHY THIS EXISTS
 * The server's importer (backend/app/routers/logs.py::import_csv_log) is
 * strict on purpose: it wants exactly `start_time, end_time, duration,
 * action, confidence`, lowercase, all non-empty. That is a fine contract for
 * a machine but a poor one for a researcher hand-building a log in Excel,
 * who will reasonably produce "Start Time"/"Action" in a different column
 * order, omit `duration` because it is derivable, and never think about
 * `confidence` at all.
 *
 * Rather than loosen the server (its contract is shared with the offline
 * sidecar and is deliberately unchanged here), this module repairs the file
 * in the browser and uploads a canonical CSV the server already accepts. The
 * person gets a forgiving importer; the API keeps its strict one.
 *
 * WHAT IT ACCEPTS
 *   - Any capitalisation: "Start Time", "START_TIME", "start-time".
 *   - Any column order.
 *   - Extra columns, which are reported as ignored rather than rejected.
 *   - Any TWO of start_time / end_time / duration; the third is derived.
 *   - Times as HH:MM:SS, MM:SS, or plain seconds, with optional decimals.
 *   - A `user_id` (or legacy `video_id`) column, meaning one combined file
 *     holding several logs, which is split back into one log per id.
 *
 * WHAT IT REQUIRES
 *   - `action`, non-empty on every row.
 *   - At least two of the three time columns.
 *
 * CONFIDENCE
 * The server requires it; the template no longer asks for it. When absent it
 * is written as 1, on the reasoning that a hand-authored or externally
 * produced log is a statement of fact rather than a prediction with a
 * probability attached. `source` is written as "csv_import" so Analytics can
 * still separate imported rows from classifier output.
 */

/** Column the server insists on, in the order it writes them itself. */
const CANONICAL_COLUMNS = [
  "start_time",
  "end_time",
  "duration",
  "action",
  "confidence",
  "source",
] as const;

/** Header spellings mapped onto the canonical name. Everything is compared
 * after lowercasing and collapsing spaces/hyphens/dots to underscores, so
 * only genuinely different words need listing here. */
const HEADER_ALIASES: Record<string, string> = {
  start_time: "start_time",
  start: "start_time",
  begin: "start_time",
  begin_time: "start_time",
  end_time: "end_time",
  end: "end_time",
  finish: "end_time",
  finish_time: "end_time",
  duration: "duration",
  length: "duration",
  elapsed: "duration",
  action: "action",
  label: "action",
  activity: "action",
  confidence: "confidence",
  score: "confidence",
  source: "source",
  user_id: "user_id",
  // Produced by this app's own combined export before the column was
  // renamed; still accepted so older exports re-import cleanly.
  video_id: "user_id",
  participant: "user_id",
  participant_id: "user_id",
};

export interface NormalisedScene {
  start_time: string;
  end_time: string;
  duration: string;
  action: string;
  confidence: number;
  source: string;
}

export interface ParsedLog {
  /** Name for the resulting log. For a combined file this is the user_id. */
  name: string;
  scenes: NormalisedScene[];
}

export interface CsvParseResult {
  ok: boolean;
  logs: ParsedLog[];
  /** Blocking problems, already phrased for display. */
  errors: string[];
  /** Non-blocking observations worth surfacing (derived columns, ignored
   * extra columns, defaulted confidence). */
  notices: string[];
}

/* ── low level parsing ─────────────────────────────────────────────────── */

/** Splits CSV text into rows of cells, honouring quoted fields that contain
 * commas, escaped double quotes, and newlines inside quotes. Written out by
 * hand rather than pulled from a dependency because it is ~30 lines and the
 * app ships no CSV parser today. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  // Strip a UTF-8 BOM, which Excel writes and which would otherwise become
  // part of the first header name.
  const src = text.replace(/^﻿/, "");

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      // Treat CRLF as one break.
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Drop rows that are entirely empty (trailing newline, blank separators).
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function normaliseHeader(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase()
    .replace(/[\s\-.]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/* ── time handling ─────────────────────────────────────────────────────── */

/** Seconds from "HH:MM:SS", "MM:SS", or "SS", each part optionally decimal.
 * Returns null when the value cannot be read as a time at all. */
export function parseTimeToSeconds(raw: string): number | null {
  const value = raw.trim();
  if (value === "") return null;
  const parts = value.split(":");
  if (parts.length > 3) return null;
  let total = 0;
  for (const part of parts) {
    if (!/^\d*\.?\d+$/.test(part.trim())) return null;
    total = total * 60 + Number(part);
  }
  return Number.isFinite(total) ? total : null;
}

/** "HH:MM:SS", keeping up to 3 decimal places only when the value actually
 * has a fractional part, so whole-second logs stay clean. */
export function formatSeconds(total: number): string {
  const safe = Math.max(0, total);
  const whole = Math.floor(safe);
  const frac = safe - whole;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const base = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  if (frac < 1e-6) return base;
  return `${base}.${String(Math.round(frac * 1000)).padStart(3, "0").replace(/0+$/, "") || "0"}`;
}

/* ── the importer ──────────────────────────────────────────────────────── */

const MAX_REPORTED_ERRORS = 8;

/**
 * Turns raw CSV text into one or more logs ready to upload, or a list of
 * problems specific enough to act on.
 *
 * `fallbackName` is used as the log name when the file is not a combined
 * export (normally the uploaded file's own name).
 */
export function parseLogCsv(text: string, fallbackName: string): CsvParseResult {
  const errors: string[] = [];
  const notices: string[] = [];

  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { ok: false, logs: [], errors: ["This file is empty."], notices };
  }

  const rawHeader = rows[0];
  const header = rawHeader.map(normaliseHeader);
  const mapped = header.map((h) => HEADER_ALIASES[h] ?? null);

  // index lookup by canonical name; first occurrence wins on duplicates
  const col: Record<string, number> = {};
  mapped.forEach((name, i) => {
    if (name && !(name in col)) col[name] = i;
  });

  const ignored = rawHeader
    .filter((_, i) => mapped[i] === null && rawHeader[i].trim() !== "")
    .map((h) => h.trim());
  if (ignored.length > 0) {
    notices.push(
      `Ignored ${ignored.length} extra column${ignored.length > 1 ? "s" : ""}: ${ignored.join(", ")}.`,
    );
  }

  // ── required columns ──
  if (!("action" in col)) {
    errors.push('Missing the "action" column. Every row must say which action it is.');
  }
  const timeCols = ["start_time", "end_time", "duration"].filter((c) => c in col);
  if (timeCols.length < 2) {
    errors.push(
      `Needs at least two of "start_time", "end_time" and "duration" so the third can be worked out. ` +
        (timeCols.length === 0 ? "None were found." : `Only "${timeCols[0]}" was found.`),
    );
  }
  if (errors.length > 0) {
    return { ok: false, logs: [], errors, notices };
  }
  if (timeCols.length === 2) {
    const derived = ["start_time", "end_time", "duration"].find((c) => !(c in col))!;
    notices.push(`Worked out "${derived}" from the other two columns.`);
  }

  const hasConfidence = "confidence" in col;
  if (!hasConfidence) {
    notices.push('No "confidence" column, so every row was recorded at 100%.');
  }
  const groupBy = "user_id" in col ? col.user_id : null;
  if (groupBy !== null) {
    notices.push('Found a "user_id" column, so this file was split into one log per id.');
  }

  // ── rows ──
  const groups = new Map<string, NormalisedScene[]>();
  let defaultedConfidence = 0;

  for (let r = 1; r < rows.length; r += 1) {
    const line = rows[r];
    const lineNo = r + 1; // 1-based, header is line 1
    const cell = (name: string): string => (col[name] === undefined ? "" : (line[col[name]] ?? "").trim());

    const action = cell("action");
    if (action === "") {
      errors.push(`Line ${lineNo}: "action" is empty.`);
      continue;
    }

    const rawStart = cell("start_time");
    const rawEnd = cell("end_time");
    const rawDur = cell("duration");

    const start = rawStart === "" ? null : parseTimeToSeconds(rawStart);
    const end = rawEnd === "" ? null : parseTimeToSeconds(rawEnd);
    const dur = rawDur === "" ? null : parseTimeToSeconds(rawDur);

    let badTime = false;
    for (const [label, raw, parsed] of [
      ["start_time", rawStart, start],
      ["end_time", rawEnd, end],
      ["duration", rawDur, dur],
    ] as const) {
      if (raw !== "" && parsed === null) {
        errors.push(
          `Line ${lineNo}: "${label}" reads "${raw}", which is not a time. Use HH:MM:SS, MM:SS, or a number of seconds.`,
        );
        badTime = true;
      }
    }
    // Skip the rest of this row: without a usable time it would also fail the
    // "needs at least two" check below, and reporting the same row twice
    // makes a long file look far more broken than it is.
    if (badTime) continue;
    if (errors.length > MAX_REPORTED_ERRORS) break;

    // Derive whichever of the three is missing.
    let s = start;
    let e = end;
    let d = dur;
    if (s !== null && e !== null) d = e - s;
    else if (s !== null && d !== null) e = s + d;
    else if (e !== null && d !== null) s = e - d;

    if (s === null || e === null || d === null) {
      errors.push(`Line ${lineNo}: needs at least two of start time, end time and duration filled in.`);
      continue;
    }
    if (d < 0) {
      errors.push(`Line ${lineNo}: ends before it starts (${rawStart || formatSeconds(s)} to ${rawEnd || formatSeconds(e)}).`);
      continue;
    }

    let confidence = 1;
    if (hasConfidence) {
      const rawConf = cell("confidence");
      if (rawConf === "") {
        defaultedConfidence += 1;
      } else {
        const n = Number(rawConf.replace(/%$/, ""));
        if (!Number.isFinite(n)) {
          errors.push(`Line ${lineNo}: "confidence" reads "${rawConf}", which is not a number.`);
          continue;
        }
        // Accept both 0-1 and 0-100 scales; anything above 1 is read as a
        // percentage, which is how a spreadsheet-authored file usually
        // writes it.
        confidence = n > 1 ? n / 100 : n;
        confidence = Math.min(1, Math.max(0, confidence));
      }
    }

    const key = groupBy === null ? fallbackName : (line[groupBy] ?? "").trim() || "unnamed";
    const scene: NormalisedScene = {
      start_time: formatSeconds(s),
      end_time: formatSeconds(e),
      duration: formatSeconds(d),
      action,
      confidence,
      source: cell("source") || "csv_import",
    };
    const bucket = groups.get(key);
    if (bucket) bucket.push(scene);
    else groups.set(key, [scene]);
  }

  if (defaultedConfidence > 0) {
    notices.push(`${defaultedConfidence} row(s) had no confidence value and were recorded at 100%.`);
  }

  if (errors.length > 0) {
    const shown = errors.slice(0, MAX_REPORTED_ERRORS);
    if (errors.length > MAX_REPORTED_ERRORS) {
      shown.push(`…and ${errors.length - MAX_REPORTED_ERRORS} more problem(s).`);
    }
    return { ok: false, logs: [], errors: shown, notices };
  }

  const logs = [...groups.entries()].map(([name, scenes]) => ({ name, scenes }));
  if (logs.length === 0 || logs.every((l) => l.scenes.length === 0)) {
    return { ok: false, logs: [], errors: ["This file has a header but no data rows."], notices };
  }

  return { ok: true, logs, errors: [], notices };
}

/* ── the exporter ──────────────────────────────────────────────────────── */

function escapeCell(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** The canonical CSV the server accepts, built from already-validated rows. */
export function buildCanonicalCsv(scenes: NormalisedScene[]): string {
  const lines = [CANONICAL_COLUMNS.join(",")];
  for (const s of scenes) {
    lines.push(CANONICAL_COLUMNS.map((c) => escapeCell(s[c as keyof NormalisedScene])).join(","));
  }
  return lines.join("\n");
}

/** One CSV holding several logs, keyed by `user_id`.
 *
 * Built here rather than by the server's /logs/combine endpoint, which emits
 * a `video_id` column of opaque job UUIDs. `user_id` carrying the log's
 * display name is what makes the file round-trip: combining logs named P01,
 * P02, P03 and re-importing the result gives back three logs with those same
 * names. */
export function buildCombinedCsv(logs: { name: string; scenes: NormalisedScene[] }[]): string {
  const header = ["user_id", ...CANONICAL_COLUMNS];
  const lines = [header.join(",")];
  for (const log of logs) {
    for (const s of log.scenes) {
      lines.push(
        [escapeCell(log.name), ...CANONICAL_COLUMNS.map((c) => escapeCell(s[c as keyof NormalisedScene]))].join(","),
      );
    }
  }
  return lines.join("\n");
}

/** The columns a person actually has to fill in, for the download template.
 * `confidence` and `source` are deliberately absent: both are optional on
 * import and asking for them invites confusion. */
export const TEMPLATE_COLUMNS = ["start_time", "end_time", "duration", "action"] as const;

export const TEMPLATE_ROWS: string[][] = [
  ["00:00:00", "00:00:05", "00:00:05", "Login screen"],
  ["00:00:05", "00:00:12", "00:00:07", "Search results"],
  ["00:00:12", "00:00:20", "00:00:08", "Checkout"],
];
