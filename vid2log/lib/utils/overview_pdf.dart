/// Formatted PDF for the Analytics Overview report, the offline
/// counterpart of the web app's "Download PDF" (frontend/lib/pdf.ts).
///
/// Deliberately plain: a title block, the four summary figures, then the
/// three tables. A PDF report is something people print and attach, so it
/// stays black-on-white rather than reproducing the app's dark theme.
library;

import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;

class OverviewPdfData {
  const OverviewPdfData({
    required this.generatedAt,
    required this.logCount,
    required this.totalScenes,
    required this.totalDurationLabel,
    required this.avgConfidenceLabel,
    required this.actionRows,
    required this.perLog,
    required this.sourceCounts,
  });

  final DateTime generatedAt;
  final int logCount;
  final int totalScenes;
  final String totalDurationLabel;
  final String avgConfidenceLabel;

  /// [action, scenes, total time, avg length, avg confidence]
  final List<List<String>> actionRows;

  /// [log name, scene count]
  final List<List<String>> perLog;

  /// [source label, count]
  final List<List<String>> sourceCounts;
}

pw.Widget _sectionTitle(String text) => pw.Padding(
      padding: const pw.EdgeInsets.only(top: 18, bottom: 6),
      child: pw.Text(text,
          style: pw.TextStyle(fontSize: 13, fontWeight: pw.FontWeight.bold)),
    );

pw.Widget _table(List<String> headers, List<List<String>> rows) => pw.TableHelper.fromTextArray(
      headers: headers,
      data: rows,
      border: null,
      headerStyle: pw.TextStyle(fontSize: 9, fontWeight: pw.FontWeight.bold),
      headerDecoration: const pw.BoxDecoration(color: PdfColors.grey200),
      cellStyle: const pw.TextStyle(fontSize: 9),
      cellHeight: 18,
      cellAlignment: pw.Alignment.centerLeft,
      rowDecoration: const pw.BoxDecoration(
        border: pw.Border(bottom: pw.BorderSide(color: PdfColors.grey300, width: 0.5)),
      ),
    );

Future<Uint8List> _build(OverviewPdfData data) async {
  final doc = pw.Document();

  doc.addPage(
    pw.MultiPage(
      pageFormat: PdfPageFormat.a4,
      margin: const pw.EdgeInsets.all(36),
      build: (context) => [
        pw.Text('vid2log, Analytics report',
            style: pw.TextStyle(fontSize: 20, fontWeight: pw.FontWeight.bold)),
        pw.SizedBox(height: 4),
        pw.Text(
          'Generated ${data.generatedAt.toLocal()}',
          style: const pw.TextStyle(fontSize: 9, color: PdfColors.grey700),
        ),
        _sectionTitle('Summary'),
        _table(
          const ['Logs analysed', 'Total scenes', 'Total duration', 'Avg. confidence'],
          [
            [
              '${data.logCount}',
              '${data.totalScenes}',
              data.totalDurationLabel,
              data.avgConfidenceLabel,
            ]
          ],
        ),
        _sectionTitle('Per-action summary'),
        pw.Text(
          'Sorted by total time spent, the actions that actually dominated these sessions, '
          'not just the ones with the most short-lived scenes.',
          style: const pw.TextStyle(fontSize: 9, color: PdfColors.grey700),
        ),
        pw.SizedBox(height: 6),
        _table(
          const ['Action', 'Scenes', 'Total time', 'Avg. scene length', 'Avg. confidence'],
          data.actionRows,
        ),
        _sectionTitle('Scenes per log'),
        _table(const ['Log', 'Scenes'], data.perLog),
        _sectionTitle('Classification source'),
        pw.Text(
          'Which tier of the hybrid classifier produced each scene\'s final label.',
          style: const pw.TextStyle(fontSize: 9, color: PdfColors.grey700),
        ),
        pw.SizedBox(height: 6),
        _table(const ['Source', 'Count'], data.sourceCounts),
      ],
      footer: (context) => pw.Align(
        alignment: pw.Alignment.centerRight,
        child: pw.Text(
          'Page ${context.pageNumber} of ${context.pagesCount}',
          style: const pw.TextStyle(fontSize: 8, color: PdfColors.grey700),
        ),
      ),
    ),
  );

  return doc.save();
}

/// Prompts for a location and writes the report. Returns the saved path, or
/// null if the user cancelled.
Future<String?> saveOverviewPdf(OverviewPdfData data) async {
  final bytes = await _build(data);
  final path = await FilePicker.platform.saveFile(
    dialogTitle: 'Save analytics report',
    fileName: 'analytics_overview_report.pdf',
    type: FileType.custom,
    allowedExtensions: ['pdf'],
  );
  if (path == null) return null;
  await File(path).writeAsBytes(bytes);
  return path;
}
