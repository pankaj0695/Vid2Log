/// CSV writing + save-dialog helper, shared by the Analytics tabs' exports.
library;

import 'dart:io';

import 'package:file_picker/file_picker.dart';

/// One titled block within a multi-section report — the Overview export
/// stacks several of these into one file (summary, per-action, per-video,
/// source breakdown), matching the web app's downloadMultiSectionCsv.
class CsvSection {
  const CsvSection({required this.title, required this.headers, required this.rows});

  final String title;
  final List<String> headers;
  final List<List<Object?>> rows;
}

String _escape(Object? value) {
  final s = value?.toString() ?? '';
  // Quote whenever the value could otherwise break the row apart. Embedded
  // quotes are doubled, per RFC 4180 — Excel and Sheets both rely on this.
  if (s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r')) {
    return '"${s.replaceAll('"', '""')}"';
  }
  return s;
}

String buildCsv(List<String> headers, List<List<Object?>> rows) {
  final buffer = StringBuffer()..writeln(headers.map(_escape).join(','));
  for (final row in rows) {
    buffer.writeln(row.map(_escape).join(','));
  }
  return buffer.toString();
}

String buildMultiSectionCsv(List<CsvSection> sections) {
  final buffer = StringBuffer();
  for (var i = 0; i < sections.length; i++) {
    final section = sections[i];
    if (i > 0) buffer.writeln();
    buffer.writeln(_escape(section.title));
    buffer.write(buildCsv(section.headers, section.rows));
  }
  return buffer.toString();
}

/// Prompts for a location and writes [content] there. Returns the saved
/// path, or null if the user cancelled.
Future<String?> saveCsv(String suggestedFilename, String content) async {
  final path = await FilePicker.platform.saveFile(
    dialogTitle: 'Save CSV',
    fileName: suggestedFilename,
    type: FileType.custom,
    allowedExtensions: ['csv'],
  );
  if (path == null) return null;
  await File(path).writeAsString(content);
  return path;
}
