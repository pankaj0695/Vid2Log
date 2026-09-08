/// Tests for utils/log_csv.dart, the forgiving CSV importer.
///
/// These mirror, assertion for assertion, the checks run against the web
/// app's `frontend/lib/logCsv.ts`. The two implementations have to agree:
/// a file that imports cleanly in the browser must import cleanly on the
/// desktop and produce the same rows, otherwise a researcher moving between
/// the two gets different logs from the same spreadsheet.
///
/// Run with: flutter test test/log_csv_test.dart
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:vid2log/utils/log_csv.dart';

void main() {
  group('parseLogCsv accepts', () {
    test('the canonical column set', () {
      final r = parseLogCsv('start_time,end_time,duration,action\n00:00:00,00:00:05,00:00:05,Login\n', 'f');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.logs.single.scenes, hasLength(1));
      expect(r.logs.single.scenes.single.confidence, 1.0);
    });

    test('shuffled columns, mixed case and spaced headers', () {
      final r = parseLogCsv('Action,END TIME,Start-Time\nLogin,00:00:05,00:00:00\n', 'f');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.logs.single.scenes.single.duration, '00:00:05');
      expect(r.logs.single.scenes.single.action, 'Login');
    });

    test('start derived from end and duration', () {
      final r = parseLogCsv('end_time,duration,action\n00:00:12,00:00:07,Search\n', 'f');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.logs.single.scenes.single.startTime, '00:00:05');
    });

    test('end derived from start and duration', () {
      final r = parseLogCsv('start_time,duration,action\n00:00:05,00:00:07,Search\n', 'f');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.logs.single.scenes.single.endTime, '00:00:12');
    });

    test('extra columns, reporting them as ignored', () {
      final r = parseLogCsv('start_time,end_time,action,notes,rater\n0,5,Login,hi,AB\n', 'f');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.notices.any((n) => n.contains('Ignored 2 extra')), isTrue, reason: r.notices.join(' | '));
    });

    test('MM:SS and bare-second times', () {
      final r = parseLogCsv('start_time,end_time,action\n0:05,12,Login\n', 'f');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.logs.single.scenes.single.duration, '00:00:07');
    });

    test('a quoted field containing a comma', () {
      final r = parseLogCsv('start_time,end_time,action\n0,5,"Login, then wait"\n', 'f');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.logs.single.scenes.single.action, 'Login, then wait');
    });

    test('confidence on both the 0-1 and 0-100 scales', () {
      final pct = parseLogCsv('start_time,end_time,action,confidence\n0,5,A,95\n', 'f');
      expect(pct.logs.single.scenes.single.confidence, closeTo(0.95, 1e-9));
      final frac = parseLogCsv('start_time,end_time,action,confidence\n0,5,A,0.42\n', 'f');
      expect(frac.logs.single.scenes.single.confidence, closeTo(0.42, 1e-9));
    });

    test('a BOM, CRLF line endings and a trailing blank line', () {
      final r = parseLogCsv('﻿start_time,end_time,action\r\n0,5,A\r\n\r\n', 'f');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.logs.single.scenes, hasLength(1));
    });
  });

  group('parseLogCsv rejects', () {
    test('only one of the three time columns', () {
      final r = parseLogCsv('start_time,action\n00:00:05,X\n', 'f');
      expect(r.ok, isFalse);
      expect(r.errors.first, contains('at least two'));
    });

    test('a missing action column', () {
      final r = parseLogCsv('start_time,end_time\n0,5\n', 'f');
      expect(r.ok, isFalse);
      expect(r.errors.first, contains('action'));
    });

    test('an unreadable time, naming the line and the value', () {
      final r = parseLogCsv('start_time,end_time,action\nbanana,00:00:05,Login\n', 'f');
      expect(r.ok, isFalse);
      expect(r.errors.first, contains('Line 2'));
      expect(r.errors.first, contains('banana'));
    });

    test('a scene that ends before it starts', () {
      final r = parseLogCsv('start_time,end_time,action\n00:00:10,00:00:05,Login\n', 'f');
      expect(r.ok, isFalse);
      expect(r.errors.first, contains('ends before it starts'));
    });

    test('an empty action cell', () {
      final r = parseLogCsv('start_time,end_time,action\n0,5,\n', 'f');
      expect(r.ok, isFalse);
      expect(r.errors.first, contains('"action" is empty'));
    });

    test('a header with no data rows', () {
      final r = parseLogCsv('start_time,end_time,action\n', 'f');
      expect(r.ok, isFalse);
      expect(r.errors.first, contains('no data rows'));
    });

    test('an empty file', () {
      final r = parseLogCsv('', 'f');
      expect(r.ok, isFalse);
      expect(r.errors.first, contains('empty'));
    });
  });

  group('combined files', () {
    test('split into one log per user_id', () {
      final r = parseLogCsv('user_id,start_time,end_time,action\nP01,0,5,A\nP02,0,3,B\nP01,5,9,C\n', 'f');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.logs, hasLength(2));
      expect(r.logs.firstWhere((l) => l.name == 'P01').scenes, hasLength(2));
      expect(r.notices.any((n) => n.contains('split into one log per id')), isTrue);
    });

    test('accept the legacy video_id column name', () {
      final r = parseLogCsv('video_id,start_time,end_time,action\nJ1,0,5,A\n', 'f');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.logs.single.name, 'J1');
    });
  });

  group('round trips', () {
    test('canonical export re-imports unchanged', () {
      final first = parseLogCsv('start_time,end_time,action\n0,5,"A,B"\n', 'f');
      final again = parseLogCsv(buildCanonicalCsv(first.logs.single.scenes), 'f');
      expect(again.ok, isTrue, reason: again.errors.join(' | '));
      expect(again.logs.single.scenes.single.action, 'A,B');
    });

    test('combined export uses user_id and splits back into the same logs', () {
      final a = parseLogCsv('start_time,end_time,action\n0,5,A\n', 'x').logs.single;
      final b = parseLogCsv('start_time,end_time,action\n0,3,B\n', 'x').logs.single;
      final csv = buildCombinedCsv([
        ParsedLog(name: 'P01', scenes: a.scenes),
        ParsedLog(name: 'P02', scenes: b.scenes),
      ]);
      expect(csv.split('\n').first, startsWith('user_id,'));

      final back = parseLogCsv(csv, 'f');
      expect(back.ok, isTrue, reason: back.errors.join(' | '));
      expect(back.logs.map((l) => l.name), containsAll(<String>['P01', 'P02']));
    });

    test('the download template is itself importable', () {
      final r = parseLogCsv(buildTemplateCsv(), 'template');
      expect(r.ok, isTrue, reason: r.errors.join(' | '));
      expect(r.logs.single.scenes, hasLength(kTemplateRows.length));
    });
  });

  group('time helpers', () {
    test('parse the three accepted shapes', () {
      expect(parseTimeToSeconds('01:01:01'), 3661);
      expect(parseTimeToSeconds('1:23'), 83);
      expect(parseTimeToSeconds('83'), 83);
      expect(parseTimeToSeconds('banana'), isNull);
      expect(parseTimeToSeconds('1:2:3:4'), isNull);
    });

    test('format whole and fractional seconds', () {
      expect(formatSeconds(3661), '01:01:01');
      expect(formatSeconds(5.5), '00:00:05.5');
      expect(formatSeconds(0), '00:00:00');
    });
  });
}
