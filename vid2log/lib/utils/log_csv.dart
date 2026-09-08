/// Reading, repairing and writing scene-log CSVs, entirely on this machine.
///
/// Dart mirror of `frontend/lib/logCsv.ts`; keep the two in sync.
///
/// WHY THIS EXISTS
/// The sidecar's importer (python_sidecar/app/main.py::import_csv_log) is
/// strict on purpose: it wants exactly `start_time, end_time, duration,
/// action, confidence`, lowercase, all non-empty. That is a fine contract
/// for a machine but a poor one for a researcher hand-building a log in
/// Excel, who will reasonably produce "Start Time"/"Action" in a different
/// column order, omit `duration` because it is derivable, and never think
/// about `confidence` at all.
///
/// Rather than loosen the sidecar (its contract is shared with the cloud
/// backend and is deliberately unchanged here), this repairs the file first
/// and hands the sidecar a canonical CSV it already accepts.
///
/// ACCEPTS: any capitalisation, any column order, extra columns, any TWO of
/// start_time/end_time/duration (the third is derived), times as HH:MM:SS,
/// MM:SS or plain seconds, and a `user_id` (or legacy `video_id`) column
/// marking a combined file that should be split into one log per id.
///
/// REQUIRES: `action` on every row, and at least two of the time columns.
///
/// CONFIDENCE: required by the sidecar, absent from the template. When
/// missing it is written as 1, since a hand-authored log is a statement of
/// fact rather than a prediction. `source` is written as "csv_import" so
/// Analytics can still separate imported rows from classifier output.
library;

/// The columns the sidecar insists on, in the order it writes them itself.
const List<String> kCanonicalColumns = [
  'start_time',
  'end_time',
  'duration',
  'action',
  'confidence',
  'source',
];

/// The columns a person actually has to fill in, for the download template.
/// `confidence` and `source` are deliberately absent: both are optional on
/// import and asking for them invites confusion.
const List<String> kTemplateColumns = ['start_time', 'end_time', 'duration', 'action'];

const List<List<String>> kTemplateRows = [
  ['00:00:00', '00:00:05', '00:00:05', 'Login screen'],
  ['00:00:05', '00:00:12', '00:00:07', 'Search results'],
  ['00:00:12', '00:00:20', '00:00:08', 'Checkout'],
];

/// Header spellings mapped onto the canonical name. Compared after
/// lowercasing and collapsing spaces/hyphens/dots to underscores, so only
/// genuinely different words need listing.
const Map<String, String> _headerAliases = {
  'start_time': 'start_time',
  'start': 'start_time',
  'begin': 'start_time',
  'begin_time': 'start_time',
  'end_time': 'end_time',
  'end': 'end_time',
  'finish': 'end_time',
  'finish_time': 'end_time',
  'duration': 'duration',
  'length': 'duration',
  'elapsed': 'duration',
  'action': 'action',
  'label': 'action',
  'activity': 'action',
  'confidence': 'confidence',
  'score': 'confidence',
  'source': 'source',
  'user_id': 'user_id',
  // Produced by this app's combined export before the column was renamed;
  // still accepted so older exports re-import cleanly.
  'video_id': 'user_id',
  'participant': 'user_id',
  'participant_id': 'user_id',
};

class NormalisedScene {
  const NormalisedScene({
    required this.startTime,
    required this.endTime,
    required this.duration,
    required this.action,
    required this.confidence,
    required this.source,
  });

  final String startTime;
  final String endTime;
  final String duration;
  final String action;
  final double confidence;
  final String source;

  String field(String canonicalColumn) => switch (canonicalColumn) {
        'start_time' => startTime,
        'end_time' => endTime,
        'duration' => duration,
        'action' => action,
        'confidence' => _trimNumber(confidence),
        'source' => source,
        _ => '',
      };
}

/// 1.0 -> "1", 0.95 -> "0.95". Keeps the CSV tidy without losing precision.
String _trimNumber(double v) {
  final s = v.toStringAsFixed(4);
  return s.contains('.') ? s.replaceFirst(RegExp(r'\.?0+$'), '') : s;
}

class ParsedLog {
  const ParsedLog({required this.name, required this.scenes});

  /// Name for the resulting log. For a combined file this is the user_id.
  final String name;
  final List<NormalisedScene> scenes;
}

class CsvParseResult {
  const CsvParseResult({
    required this.ok,
    required this.logs,
    required this.errors,
    required this.notices,
  });

  final bool ok;
  final List<ParsedLog> logs;

  /// Blocking problems, already phrased for display.
  final List<String> errors;

  /// Non-blocking observations worth surfacing.
  final List<String> notices;
}

// ── low level parsing ───────────────────────────────────────────────────

/// Splits CSV text into rows of cells, honouring quoted fields containing
/// commas, escaped double quotes, and newlines inside quotes.
List<List<String>> parseCsv(String text) {
  final rows = <List<String>>[];
  var row = <String>[];
  final cell = StringBuffer();
  var inQuotes = false;

  // Strip a UTF-8 BOM, which Excel writes and which would otherwise become
  // part of the first header name.
  final src = text.startsWith('﻿') ? text.substring(1) : text;

  for (var i = 0; i < src.length; i++) {
    final ch = src[i];
    if (inQuotes) {
      if (ch == '"') {
        if (i + 1 < src.length && src[i + 1] == '"') {
          cell.write('"');
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell.write(ch);
      }
      continue;
    }
    if (ch == '"') {
      inQuotes = true;
    } else if (ch == ',') {
      row.add(cell.toString());
      cell.clear();
    } else if (ch == '\n' || ch == '\r') {
      if (ch == '\r' && i + 1 < src.length && src[i + 1] == '\n') i++;
      row.add(cell.toString());
      rows.add(row);
      row = <String>[];
      cell.clear();
    } else {
      cell.write(ch);
    }
  }
  if (cell.isNotEmpty || row.isNotEmpty) {
    row.add(cell.toString());
    rows.add(row);
  }
  return rows.where((r) => r.any((c) => c.trim().isNotEmpty)).toList();
}

String _normaliseHeader(String raw) {
  var h = raw.trim();
  h = h.replaceAll(RegExp(r'''^["']|["']$'''), '');
  h = h.toLowerCase();
  h = h.replaceAll(RegExp(r'[\s\-.]+'), '_');
  h = h.replaceAll(RegExp(r'^_+|_+$'), '');
  return h;
}

// ── time handling ───────────────────────────────────────────────────────

/// Seconds from "HH:MM:SS", "MM:SS", or "SS", each part optionally decimal.
/// Null when the value cannot be read as a time at all.
double? parseTimeToSeconds(String raw) {
  final value = raw.trim();
  if (value.isEmpty) return null;
  final parts = value.split(':');
  if (parts.length > 3) return null;
  var total = 0.0;
  for (final part in parts) {
    final p = part.trim();
    if (!RegExp(r'^\d*\.?\d+$').hasMatch(p)) return null;
    final n = double.tryParse(p);
    if (n == null) return null;
    total = total * 60 + n;
  }
  return total.isFinite ? total : null;
}

/// "HH:MM:SS", keeping up to 3 decimal places only when the value actually
/// has a fractional part, so whole-second logs stay clean.
String formatSeconds(double total) {
  final safe = total < 0 ? 0.0 : total;
  final whole = safe.floor();
  final frac = safe - whole;
  final h = whole ~/ 3600;
  final m = (whole % 3600) ~/ 60;
  final s = whole % 60;
  final base = '${h.toString().padLeft(2, '0')}:'
      '${m.toString().padLeft(2, '0')}:'
      '${s.toString().padLeft(2, '0')}';
  if (frac < 1e-6) return base;
  var ms = (frac * 1000).round().toString().padLeft(3, '0');
  ms = ms.replaceFirst(RegExp(r'0+$'), '');
  return '$base.${ms.isEmpty ? '0' : ms}';
}

// ── the importer ────────────────────────────────────────────────────────

const int _maxReportedErrors = 8;

/// Turns raw CSV text into one or more logs ready to import, or a list of
/// problems specific enough to act on.
///
/// [fallbackName] names the log when the file is not a combined export
/// (normally the chosen file's own name).
CsvParseResult parseLogCsv(String text, String fallbackName) {
  final errors = <String>[];
  final notices = <String>[];

  final rows = parseCsv(text);
  if (rows.isEmpty) {
    return CsvParseResult(ok: false, logs: const [], errors: ['This file is empty.'], notices: notices);
  }

  final rawHeader = rows.first;
  final mapped = rawHeader.map((h) => _headerAliases[_normaliseHeader(h)]).toList();

  final col = <String, int>{};
  for (var i = 0; i < mapped.length; i++) {
    final name = mapped[i];
    if (name != null && !col.containsKey(name)) col[name] = i;
  }

  final ignored = <String>[];
  for (var i = 0; i < rawHeader.length; i++) {
    if (mapped[i] == null && rawHeader[i].trim().isNotEmpty) ignored.add(rawHeader[i].trim());
  }
  if (ignored.isNotEmpty) {
    notices.add('Ignored ${ignored.length} extra column${ignored.length > 1 ? 's' : ''}: ${ignored.join(', ')}.');
  }

  if (!col.containsKey('action')) {
    errors.add('Missing the "action" column. Every row must say which action it is.');
  }
  final timeCols = ['start_time', 'end_time', 'duration'].where(col.containsKey).toList();
  if (timeCols.length < 2) {
    errors.add(
      'Needs at least two of "start_time", "end_time" and "duration" so the third can be worked out. '
      '${timeCols.isEmpty ? 'None were found.' : 'Only "${timeCols.first}" was found.'}',
    );
  }
  if (errors.isNotEmpty) {
    return CsvParseResult(ok: false, logs: const [], errors: errors, notices: notices);
  }
  if (timeCols.length == 2) {
    final derived = ['start_time', 'end_time', 'duration'].firstWhere((c) => !col.containsKey(c));
    notices.add('Worked out "$derived" from the other two columns.');
  }

  final hasConfidence = col.containsKey('confidence');
  if (!hasConfidence) {
    notices.add('No "confidence" column, so every row was recorded at 100%.');
  }
  final groupBy = col['user_id'];
  if (groupBy != null) {
    notices.add('Found a "user_id" column, so this file was split into one log per id.');
  }

  final groups = <String, List<NormalisedScene>>{};
  var defaultedConfidence = 0;

  for (var r = 1; r < rows.length; r++) {
    final line = rows[r];
    final lineNo = r + 1; // 1-based; header is line 1
    String cellOf(String name) {
      final idx = col[name];
      if (idx == null || idx >= line.length) return '';
      return line[idx].trim();
    }

    final action = cellOf('action');
    if (action.isEmpty) {
      errors.add('Line $lineNo: "action" is empty.');
      continue;
    }

    final rawStart = cellOf('start_time');
    final rawEnd = cellOf('end_time');
    final rawDur = cellOf('duration');

    final start = rawStart.isEmpty ? null : parseTimeToSeconds(rawStart);
    final end = rawEnd.isEmpty ? null : parseTimeToSeconds(rawEnd);
    final dur = rawDur.isEmpty ? null : parseTimeToSeconds(rawDur);

    var badTime = false;
    for (final entry in [
      ('start_time', rawStart, start),
      ('end_time', rawEnd, end),
      ('duration', rawDur, dur),
    ]) {
      if (entry.$2.isNotEmpty && entry.$3 == null) {
        errors.add(
          'Line $lineNo: "${entry.$1}" reads "${entry.$2}", which is not a time. '
          'Use HH:MM:SS, MM:SS, or a number of seconds.',
        );
        badTime = true;
      }
    }
    if (badTime) continue;
    if (errors.length > _maxReportedErrors) break;

    var s = start;
    var e = end;
    var d = dur;
    if (s != null && e != null) {
      d = e - s;
    } else if (s != null && d != null) {
      e = s + d;
    } else if (e != null && d != null) {
      s = e - d;
    }

    if (s == null || e == null || d == null) {
      errors.add('Line $lineNo: needs at least two of start time, end time and duration filled in.');
      continue;
    }
    if (d < 0) {
      errors.add('Line $lineNo: ends before it starts (${formatSeconds(s)} to ${formatSeconds(e)}).');
      continue;
    }

    var confidence = 1.0;
    if (hasConfidence) {
      final rawConf = cellOf('confidence');
      if (rawConf.isEmpty) {
        defaultedConfidence++;
      } else {
        final n = double.tryParse(rawConf.replaceFirst(RegExp(r'%$'), ''));
        if (n == null) {
          errors.add('Line $lineNo: "confidence" reads "$rawConf", which is not a number.');
          continue;
        }
        // Accept both 0-1 and 0-100 scales; anything above 1 is read as a
        // percentage, which is how a spreadsheet usually writes it.
        confidence = n > 1 ? n / 100 : n;
        confidence = confidence.clamp(0.0, 1.0);
      }
    }

    final key = groupBy == null
        ? fallbackName
        : (groupBy < line.length && line[groupBy].trim().isNotEmpty ? line[groupBy].trim() : 'unnamed');

    groups.putIfAbsent(key, () => <NormalisedScene>[]).add(
          NormalisedScene(
            startTime: formatSeconds(s),
            endTime: formatSeconds(e),
            duration: formatSeconds(d),
            action: action,
            confidence: confidence,
            source: cellOf('source').isEmpty ? 'csv_import' : cellOf('source'),
          ),
        );
  }

  if (defaultedConfidence > 0) {
    notices.add('$defaultedConfidence row(s) had no confidence value and were recorded at 100%.');
  }

  if (errors.isNotEmpty) {
    final shown = errors.take(_maxReportedErrors).toList();
    if (errors.length > _maxReportedErrors) {
      shown.add('…and ${errors.length - _maxReportedErrors} more problem(s).');
    }
    return CsvParseResult(ok: false, logs: const [], errors: shown, notices: notices);
  }

  final logs = groups.entries.map((e) => ParsedLog(name: e.key, scenes: e.value)).toList();
  if (logs.isEmpty || logs.every((l) => l.scenes.isEmpty)) {
    return CsvParseResult(
      ok: false,
      logs: const [],
      errors: const ['This file has a header but no data rows.'],
      notices: notices,
    );
  }

  return CsvParseResult(ok: true, logs: logs, errors: const [], notices: notices);
}

// ── the exporter ────────────────────────────────────────────────────────

String _escapeCell(String value) =>
    RegExp(r'[",\n]').hasMatch(value) ? '"${value.replaceAll('"', '""')}"' : value;

/// The canonical CSV the sidecar accepts, built from validated rows.
String buildCanonicalCsv(List<NormalisedScene> scenes) {
  final lines = <String>[kCanonicalColumns.join(',')];
  for (final s in scenes) {
    lines.add(kCanonicalColumns.map((c) => _escapeCell(s.field(c))).join(','));
  }
  return lines.join('\n');
}

/// One CSV holding several logs, keyed by `user_id`.
///
/// The cloud backend's own /logs/combine emits a `video_id` column of opaque
/// job UUIDs. `user_id` carrying the log's display name is what makes the
/// file round-trip: combining logs named P01, P02, P03 and re-importing the
/// result gives back three logs with those same names.
String buildCombinedCsv(List<ParsedLog> logs) {
  final lines = <String>[(['user_id', ...kCanonicalColumns]).join(',')];
  for (final log in logs) {
    for (final s in log.scenes) {
      lines.add([
        _escapeCell(log.name),
        ...kCanonicalColumns.map((c) => _escapeCell(s.field(c))),
      ].join(','));
    }
  }
  return lines.join('\n');
}

/// The 4-column starter file offered by "CSV template".
String buildTemplateCsv() {
  final lines = <String>[kTemplateColumns.join(',')];
  for (final row in kTemplateRows) {
    lines.add(row.map(_escapeCell).join(','));
  }
  return lines.join('\n');
}
