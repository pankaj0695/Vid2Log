// Builds the Analytics Overview "Download PDF" report. jsPDF + jspdf-autotable
// generate the file entirely client-side — no server round-trip needed, same
// spirit as lib/csv.ts's CSV export.
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export interface OverviewReportData {
  generatedAt: Date;
  videoCount: number;
  totalScenes: number;
  totalDurationLabel: string;
  avgConfidencePct: string;
  classRows: { label: string; count: number; totalSec: number; avgDurationSec: number; avgConfidence: number }[];
  perVideo: { label: string; value: number }[];
  sourceCounts: { label: string; value: number }[];
  formatSeconds: (seconds: number) => string;
}

const MARGIN_X = 14;
const PAGE_BREAK_Y = 260;
const ACCENT_RGB: [number, number, number] = [45, 212, 191]; // matches the app's teal primary

function nextY(doc: jsPDF): number {
  // jspdf-autotable stamps `lastAutoTable.finalY` onto the document at
  // runtime (see its source) but doesn't expose it in the .d.ts for the
  // jsPDF type this function receives — hence the cast.
  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY;
  return (finalY ?? 20) + 10;
}

function sectionHeading(doc: jsPDF, title: string, y: number): number {
  if (y > PAGE_BREAK_Y) {
    doc.addPage();
    y = 18;
  }
  doc.setFontSize(12);
  doc.setTextColor(20);
  doc.text(title, MARGIN_X, y);
  return y + 5;
}

export function downloadOverviewPdf(data: OverviewReportData) {
  const doc = new jsPDF();
  let y = 18;

  doc.setFontSize(16);
  doc.text("vid2log Analytics Report", MARGIN_X, y);
  y += 7;
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generated ${data.generatedAt.toLocaleString()}`, MARGIN_X, y);
  doc.setTextColor(0);
  y += 8;

  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X },
    head: [["Videos analyzed", "Total scenes", "Total duration", "Avg. confidence"]],
    body: [[String(data.videoCount), String(data.totalScenes), data.totalDurationLabel, data.avgConfidencePct]],
    theme: "grid",
    styles: { fontSize: 9 },
    headStyles: { fillColor: ACCENT_RGB, textColor: 20 },
  });
  y = nextY(doc);

  y = sectionHeading(doc, "Per-class summary", y);
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X },
    head: [["Class", "Scenes", "Total time", "Avg. scene length", "Avg. confidence"]],
    body: data.classRows.map((r) => [
      r.label,
      String(r.count),
      data.formatSeconds(r.totalSec),
      data.formatSeconds(r.avgDurationSec),
      `${(r.avgConfidence * 100).toFixed(1)}%`,
    ]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: ACCENT_RGB, textColor: 20 },
  });
  y = nextY(doc);

  y = sectionHeading(doc, "Scenes per video", y);
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X },
    head: [["Video", "Scenes"]],
    body: data.perVideo.map((v) => [v.label, String(v.value)]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: ACCENT_RGB, textColor: 20 },
  });
  y = nextY(doc);

  y = sectionHeading(doc, "Classification source", y);
  autoTable(doc, {
    startY: y,
    margin: { left: MARGIN_X, right: MARGIN_X },
    head: [["Source", "Count"]],
    body: data.sourceCounts.map((s) => [s.label, String(s.value)]),
    styles: { fontSize: 9 },
    headStyles: { fillColor: ACCENT_RGB, textColor: 20 },
  });

  doc.save("vid2log_analytics_report.pdf");
}
