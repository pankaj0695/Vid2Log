// Tiny client-side CSV export helper — builds a CSV string in-browser and
// triggers a download via a Blob URL, no server round-trip needed.

function escapeCsvCell(value: string | number): string {
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Turns one table into CSV lines (no trailing join) — exposed separately
 * from downloadCsv so multi-section reports can build several tables and
 * concatenate them (with blank-line separators) into one file. */
export function toCsvLines(headers: string[], rows: (string | number)[][]): string[] {
  return [headers, ...rows].map((row) => row.map(escapeCsvCell).join(","));
}

function triggerDownload(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  triggerDownload(filename, toCsvLines(headers, rows).join("\n"), "text/csv;charset=utf-8;");
}

/** Reads just the header row of a CSV file's text and returns which of
 * `requiredColumns` are missing (case-insensitive, so "Start_Time" still
 * matches "start_time") — empty array means every required column is
 * present. Used to reject an obviously-wrong CSV client-side, before ever
 * uploading it, so the person finds out exactly which column(s) to fix
 * instead of a generic "import failed" after a round trip. */
export function findMissingCsvColumns(csvText: string, requiredColumns: string[]): string[] {
  const headerLine = csvText.split(/\r\n|\r|\n/, 1)[0] ?? "";
  const present = new Set(
    headerLine.split(",").map((cell) => cell.trim().replace(/^["']|["']$/g, "").toLowerCase())
  );
  return requiredColumns.filter((col) => !present.has(col.toLowerCase()));
}

/** For reports made of several distinct tables — pass an ordered list of
 * { title, headers, rows } and this lays them out as one CSV with a title
 * line and a blank line between each section. */
export function downloadMultiSectionCsv(
  filename: string,
  sections: { title: string; headers: string[]; rows: (string | number)[][] }[]
) {
  const blocks = sections.map((s) => [s.title, ...toCsvLines(s.headers, s.rows)].join("\n"));
  triggerDownload(filename, blocks.join("\n\n"), "text/csv;charset=utf-8;");
}
