/// Ported from frontend/app/analytics/page.tsx — four tabs over the scene
/// logs already stored locally:
///
///   Overview — descriptive stats across whichever logs you pick (totals,
///              per-action time/confidence, scenes per log, which tier
///              decided each label), computed on demand rather than over
///              "recent" logs, so the numbers always describe a set you
///              consciously chose.
///   SPM      — frequent activity sub-sequences: common workflows, loops
///              and rework, with S-support and I-support.
///   DSM      — the same mining run on two groups, then a statistical test
///              per pattern: what's *significantly* different between them.
///   Timeline — each selected log's actions laid out along time.
///
/// Overview is computed here in Dart from scene rows the sidecar already
/// returns; SPM/DSM run in the sidecar (python_sidecar/app/analytics.py)
/// since they need the PrefixSpan engine and scipy.
library;

import 'package:flutter/material.dart';

import '../models/analytics.dart';
import '../models/job.dart';
import '../services/api_client.dart';
import '../utils/csv_export.dart';
import '../utils/overview_pdf.dart';
import '../widgets/charts.dart';
import '../widgets/log_select_list.dart';
import '../widgets/ui.dart';

enum _Tab { overview, spm, dsm, timeline }

/// Human labels for the `source` field on a scene row — which tier of the
/// hybrid classifier decided that label (see the sidecar's
/// app/ml/hybrid_classifier.py).
const Map<String, String> _sourceLabels = {
  'cnn': 'CNN (visual)',
  'fusion': 'CNN + OCR text',
  'keyword_rule': 'Keyword rule',
  'csv_import': 'Imported CSV',
  'manual': 'Manual',
};

double _parseHms(String s) {
  var total = 0.0;
  for (final part in s.split(':')) {
    total = total * 60 + (double.tryParse(part) ?? 0);
  }
  return total;
}

String _formatSeconds(double totalSeconds) {
  final t = totalSeconds.round();
  final h = t ~/ 3600;
  final m = (t % 3600) ~/ 60;
  final s = t % 60;
  if (h > 0) return '${h}h ${m}m';
  if (m > 0) return '${m}m ${s}s';
  return '${s}s';
}

class _ActionRow {
  const _ActionRow({
    required this.action,
    required this.count,
    required this.totalSec,
    required this.avgDurationSec,
    required this.avgConfidence,
  });

  final String action;
  final int count;
  final double totalSec;
  final double avgDurationSec;
  final double avgConfidence;
}

class _OverviewResult {
  const _OverviewResult({
    required this.logCount,
    required this.totalScenes,
    required this.totalDurationSec,
    required this.avgConfidence,
    required this.actionRows,
    required this.sourceCounts,
    required this.perLog,
  });

  final int logCount;
  final int totalScenes;
  final double totalDurationSec;
  final double avgConfidence;
  final List<_ActionRow> actionRows;
  final Map<String, int> sourceCounts;
  final List<(String label, int scenes)> perLog;
}

/// Colours for every action seen across ALL logs, assigned by index over a
/// stable sorted order. Building it once at this level (rather than per
/// chart or per timeline) is what makes an action the same colour
/// everywhere on the page — and building it from a sorted list rather than
/// hashing is what guarantees two actions never collide onto one colour.
Map<String, Color> _actionColorsFor(Iterable<Job> logs) {
  final actions = <String>{};
  for (final job in logs) {
    for (final scene in job.scenes ?? const <Scene>[]) {
      actions.add(scene.action);
    }
  }
  final sorted = actions.toList()..sort();
  return buildColorMap(sorted);
}

class AnalyticsScreen extends StatefulWidget {
  const AnalyticsScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<AnalyticsScreen> createState() => _AnalyticsScreenState();
}

class _AnalyticsScreenState extends State<AnalyticsScreen> {
  _Tab _tab = _Tab.overview;

  List<Job>? _logs;
  String? _logsError;

  /// One action → one colour, shared by every chart and timeline on the
  /// page. Rebuilt whenever the log list changes.
  Map<String, Color> _actionColors = const {};

  // Overview
  final Set<String> _overviewSelection = {};
  _OverviewResult? _overview;
  bool _overviewRunning = false;
  String? _overviewError;

  // SPM
  final Set<String> _spmSelection = {};
  List<SpmPattern>? _spmResults;
  bool _spmRunning = false;
  String? _spmError;
  bool _spmAdvanced = false;
  String _spmSortBy = 's_support';
  final _spmOpts = _OptionControllers();

  // DSM
  final Set<String> _groupA = {};
  final Set<String> _groupB = {};
  List<DsmPattern>? _dsmResults;
  bool _dsmRunning = false;
  String? _dsmError;
  bool _dsmAdvanced = false;
  final _dsmOpts = _OptionControllers();
  List<String> _testTypes = const ['ttest_ind'];
  String _testType = 'ttest_ind';
  final _pValueController = TextEditingController(text: '0.1');

  // Timeline
  final Set<String> _timelineSelection = {};

  @override
  void initState() {
    super.initState();
    _loadLogs();
    _loadTestTypes();
  }

  @override
  void dispose() {
    _spmOpts.dispose();
    _dsmOpts.dispose();
    _pValueController.dispose();
    super.dispose();
  }

  Future<void> _loadLogs() async {
    try {
      final jobs = await widget.apiClient.listJobs(limit: 100);
      if (!mounted) return;
      final done = jobs.where((j) => j.status == JobStatus.done).toList();
      setState(() {
        _logs = done;
        _actionColors = _actionColorsFor(done);
        _logsError = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _logsError = '$e');
    }
  }

  Future<void> _loadTestTypes() async {
    try {
      final types = await widget.apiClient.listTestTypes();
      if (!mounted || types.isEmpty) return;
      setState(() => _testTypes = types);
    } catch (_) {
      // Falls back to the single default, which the sidecar always accepts.
    }
  }

  List<Job> get _doneLogs => _logs ?? const [];

  // ── Overview ───────────────────────────────────────────────────────────

  Future<void> _runOverview() async {
    if (_overviewSelection.isEmpty) {
      setState(() => _overviewError = 'Select at least one log.');
      return;
    }
    setState(() {
      _overviewRunning = true;
      _overviewError = null;
    });
    try {
      final selected = _doneLogs.where((j) => _overviewSelection.contains(j.jobId)).toList();
      // Refetch each log rather than trusting the list response: GET /jobs
      // returns scene rows too, but refetching keeps this correct if that
      // ever becomes a trimmed summary for performance.
      final full = await Future.wait(selected.map((j) => widget.apiClient.getJob(j.jobId)));

      final counts = <String, int>{};
      final totals = <String, double>{};
      final confSums = <String, double>{};
      final sourceCounts = <String, int>{};
      final perLog = <(String, int)>[];
      var totalScenes = 0;
      var totalDuration = 0.0;
      var confSum = 0.0;

      for (var i = 0; i < full.length; i++) {
        final scenes = full[i].scenes ?? const <Scene>[];
        perLog.add((selected[i].label, scenes.length));
        for (final scene in scenes) {
          final sec = _parseHms(scene.duration);
          counts[scene.action] = (counts[scene.action] ?? 0) + 1;
          totals[scene.action] = (totals[scene.action] ?? 0) + sec;
          confSums[scene.action] = (confSums[scene.action] ?? 0) + scene.confidence;
          sourceCounts[scene.source] = (sourceCounts[scene.source] ?? 0) + 1;
          totalScenes += 1;
          totalDuration += sec;
          confSum += scene.confidence;
        }
      }

      final actionRows = counts.keys
          .map((action) => _ActionRow(
                action: action,
                count: counts[action]!,
                totalSec: totals[action]!,
                avgDurationSec: totals[action]! / counts[action]!,
                avgConfidence: confSums[action]! / counts[action]!,
              ))
          .toList()
        ..sort((a, b) => b.totalSec.compareTo(a.totalSec));

      if (!mounted) return;
      setState(() {
        _overview = _OverviewResult(
          logCount: selected.length,
          totalScenes: totalScenes,
          totalDurationSec: totalDuration,
          avgConfidence: totalScenes == 0 ? 0 : confSum / totalScenes,
          actionRows: actionRows,
          sourceCounts: sourceCounts,
          perLog: perLog,
        );
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _overviewError = '$e');
    } finally {
      if (mounted) setState(() => _overviewRunning = false);
    }
  }

  Future<void> _exportOverview() async {
    final r = _overview;
    if (r == null) return;
    final csv = buildMultiSectionCsv([
      CsvSection(
        title: 'Summary',
        headers: const ['Logs analysed', 'Total scenes', 'Total duration', 'Avg. confidence'],
        rows: [
          [
            r.logCount,
            r.totalScenes,
            _formatSeconds(r.totalDurationSec),
            '${(r.avgConfidence * 100).toStringAsFixed(1)}%',
          ]
        ],
      ),
      CsvSection(
        title: 'Per-action summary',
        headers: const [
          'Action',
          'Scenes',
          'Total time (s)',
          'Avg. scene length (s)',
          'Avg. confidence'
        ],
        rows: r.actionRows
            .map((a) => [
                  a.action,
                  a.count,
                  a.totalSec.toStringAsFixed(1),
                  a.avgDurationSec.toStringAsFixed(1),
                  '${(a.avgConfidence * 100).toStringAsFixed(1)}%',
                ])
            .toList(),
      ),
      CsvSection(
        title: 'Scenes per log',
        headers: const ['Log', 'Scenes'],
        rows: r.perLog.map((v) => [v.$1, v.$2]).toList(),
      ),
      CsvSection(
        title: 'Classification source',
        headers: const ['Source', 'Count'],
        rows: r.sourceCounts.entries
            .map((e) => [_sourceLabels[e.key] ?? e.key, e.value])
            .toList(),
      ),
    ]);
    await _saveAndNotify('analytics_overview_report.csv', csv);
  }

  Future<void> _exportOverviewPdf() async {
    final r = _overview;
    if (r == null) return;
    try {
      final path = await saveOverviewPdf(OverviewPdfData(
        generatedAt: DateTime.now(),
        logCount: r.logCount,
        totalScenes: r.totalScenes,
        totalDurationLabel: _formatSeconds(r.totalDurationSec),
        avgConfidenceLabel: '${(r.avgConfidence * 100).toStringAsFixed(1)}%',
        actionRows: r.actionRows
            .map((a) => [
                  a.action,
                  '${a.count}',
                  _formatSeconds(a.totalSec),
                  _formatSeconds(a.avgDurationSec),
                  '${(a.avgConfidence * 100).toStringAsFixed(1)}%',
                ])
            .toList(),
        perLog: r.perLog.map((v) => [v.$1, '${v.$2}']).toList(),
        sourceCounts: r.sourceCounts.entries
            .map((e) => [_sourceLabels[e.key] ?? e.key, '${e.value}'])
            .toList(),
      ));
      if (path != null && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Saved to $path')));
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _saveAndNotify(String filename, String csv) async {
    try {
      final path = await saveCsv(filename, csv);
      if (path != null && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Saved to $path')));
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  // ── SPM / DSM ──────────────────────────────────────────────────────────

  Future<void> _runSpm() async {
    if (_spmSelection.length < 2) {
      setState(() => _spmError = 'Select at least 2 logs — patterns are found across logs.');
      return;
    }
    setState(() {
      _spmRunning = true;
      _spmError = null;
    });
    try {
      final results = await widget.apiClient.runSpm(
        jobIds: _spmSelection.toList(),
        options: _spmOpts.build(),
        sortBy: _spmSortBy,
      );
      if (!mounted) return;
      setState(() => _spmResults = results);
    } catch (e) {
      if (!mounted) return;
      setState(() => _spmError = '$e');
    } finally {
      if (mounted) setState(() => _spmRunning = false);
    }
  }

  Future<void> _exportSpm() async {
    final results = _spmResults;
    if (results == null || results.isEmpty) return;
    final csv = buildCsv(
      const ['Pattern', 'S-frequency', 'S-support', 'I-frequency', 'I-support (mean)', 'I-support (sd)'],
      results
          .map((p) => [
                p.pattern.join(' → '),
                p.support,
                p.supportFraction.toStringAsFixed(3),
                p.iFrequency,
                p.iSupportMean.toStringAsFixed(3),
                p.iSupportSd.toStringAsFixed(3),
              ])
          .toList(),
    );
    await _saveAndNotify('spm_patterns.csv', csv);
  }

  Future<void> _runDsm() async {
    if (_groupA.isEmpty || _groupB.isEmpty) {
      setState(() => _dsmError = 'Both groups need at least one log.');
      return;
    }
    // The pickers already make overlap impossible (each disables the
    // other's selection), but a stale-state bug here would silently produce
    // a meaningless comparison rather than an error — cheap to keep.
    final overlap = _groupA.intersection(_groupB);
    if (overlap.isNotEmpty) {
      setState(() => _dsmError =
          '${overlap.length} log(s) are in both groups — remove them from one side.');
      return;
    }
    setState(() {
      _dsmRunning = true;
      _dsmError = null;
    });
    try {
      final results = await widget.apiClient.runDsm(
        groupAJobIds: _groupA.toList(),
        groupBJobIds: _groupB.toList(),
        options: _dsmOpts.build(),
        testType: _testType,
        thresholdPValue: double.tryParse(_pValueController.text.trim()) ?? 0.1,
      );
      if (!mounted) return;
      setState(() => _dsmResults = results);
    } catch (e) {
      if (!mounted) return;
      setState(() => _dsmError = '$e');
    } finally {
      if (mounted) setState(() => _dsmRunning = false);
    }
  }

  Future<void> _exportDsm() async {
    final results = _dsmResults;
    if (results == null || results.isEmpty) return;
    final csv = buildCsv(
      const ['Pattern', 'p-value', 'I-support (group A)', 'I-support (group B)', 'Characteristic of'],
      results
          .map((p) => [
                p.pattern.join(' → '),
                p.pValue.toStringAsExponential(3),
                p.isupportLeftMean?.toStringAsFixed(3) ?? '',
                p.isupportRightMean?.toStringAsFixed(3) ?? '',
                p.group == 'left' ? 'Group A' : 'Group B',
              ])
          .toList(),
    );
    await _saveAndNotify('dsm_patterns.csv', csv);
  }

  // ── Build ──────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const PageHeader(eyebrow: 'Analytics', title: 'Analytics'),
          VidTabs<_Tab>(
            tabs: const [
              (_Tab.overview, 'Overview'),
              (_Tab.spm, 'Sequential patterns (SPM)'),
              (_Tab.dsm, 'Differential patterns (DSM)'),
              (_Tab.timeline, 'Video timeline'),
            ],
            active: _tab,
            onChange: (t) => setState(() => _tab = t),
          ),
          if (_logsError != null) ...[DangerAlert(message: _logsError!), const SizedBox(height: 16)],
          if (_logs == null)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 60),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_doneLogs.isEmpty)
            const EmptyStateWidget(
              title: 'No logs to analyse yet',
              subtitle: 'Process a video, or import a CSV log, and it\'ll show up here.',
            )
          else
            switch (_tab) {
              _Tab.overview => _buildOverviewTab(),
              _Tab.spm => _buildSpmTab(),
              _Tab.dsm => _buildDsmTab(),
              _Tab.timeline => _buildTimelineTab(),
            },
        ],
      ),
    );
  }

  // ── Overview tab ──

  Widget _buildOverviewTab() {
    final r = _overview;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Select-logs card beside a narrower "Generate report" card, same
        // 2:1 split as the web page.
        LayoutBuilder(builder: (context, constraints) {
          final selectCard = VidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const VidCardHeader(title: 'Select logs'),
                LogSelectList(
                  jobs: _doneLogs,
                  selected: _overviewSelection,
                  onChanged: (next) => setState(() {
                    _overviewSelection
                      ..clear()
                      ..addAll(next);
                  }),
                ),
              ],
            ),
          );
          final runCard = VidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const VidCardHeader(title: 'Generate report'),
                Text(
                  '${_overviewSelection.length} log${_overviewSelection.length == 1 ? '' : 's'} selected',
                  style: const TextStyle(color: VidColors.neutral500, fontSize: 13),
                ),
                const SizedBox(height: 14),
                FilledButton.icon(
                  onPressed: _overviewRunning ? null : _runOverview,
                  icon: _overviewRunning
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2, color: VidColors.ink))
                      : const Icon(Icons.insights_outlined, size: 18),
                  label: Text(_overviewRunning ? 'Analysing…' : 'Generate report'),
                ),
                if (_overviewError != null) ...[
                  const SizedBox(height: 12),
                  DangerAlert(message: _overviewError!),
                ],
              ],
            ),
          );

          if (constraints.maxWidth < 860) {
            return Column(children: [selectCard, const SizedBox(height: 16), runCard]);
          }
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(flex: 2, child: selectCard),
              const SizedBox(width: 16),
              Expanded(child: runCard),
            ],
          );
        }),
        if (r != null) ...[
          const SizedBox(height: 20),
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Download this report as a spreadsheet or a formatted PDF.',
                  style: TextStyle(color: VidColors.neutral500, fontSize: 13),
                ),
              ),
              OutlinedButton.icon(
                onPressed: _exportOverview,
                icon: const Icon(Icons.download, size: 18),
                label: const Text('Download CSV'),
              ),
              const SizedBox(width: 8),
              OutlinedButton.icon(
                onPressed: _exportOverviewPdf,
                icon: const Icon(Icons.picture_as_pdf_outlined, size: 18),
                label: const Text('Download PDF'),
              ),
            ],
          ),
          const SizedBox(height: 16),
          LayoutBuilder(builder: (context, constraints) {
            final cols = constraints.maxWidth > 900 ? 4 : 2;
            return GridView.count(
              crossAxisCount: cols,
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              crossAxisSpacing: 16,
              mainAxisSpacing: 16,
              childAspectRatio: 2.1,
              children: [
                StatCard(label: 'Logs analysed', value: '${r.logCount}'),
                StatCard(label: 'Total scenes', value: '${r.totalScenes}'),
                StatCard(label: 'Total duration', value: _formatSeconds(r.totalDurationSec)),
                StatCard(
                    label: 'Avg. confidence',
                    value: '${(r.avgConfidence * 100).toStringAsFixed(1)}%'),
              ],
            );
          }),
          const SizedBox(height: 20),
          VidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const VidCardHeader(title: 'Per-action summary'),
                const Text(
                  'Sorted by total time spent — the actions that actually dominated these '
                  'sessions, not just the ones with the most short-lived scenes.',
                  style: TextStyle(color: VidColors.neutral500, fontSize: 12, height: 1.5),
                ),
                const SizedBox(height: 12),
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: DataTable(
                    columnSpacing: 28,
                    columns: const [
                      DataColumn(label: Text('Action')),
                      DataColumn(label: Text('Scenes')),
                      DataColumn(label: Text('Total time')),
                      DataColumn(label: Text('Avg. scene length')),
                      DataColumn(label: Text('Avg. confidence')),
                    ],
                    rows: r.actionRows
                        .map((a) => DataRow(cells: [
                              DataCell(Row(children: [
                                Container(
                                  width: 10,
                                  height: 10,
                                  decoration: BoxDecoration(
                                    color: _actionColors[a.action] ?? VidColors.primary,
                                    borderRadius: BorderRadius.circular(2),
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Text(a.action),
                              ])),
                              DataCell(Text('${a.count}')),
                              DataCell(Text(_formatSeconds(a.totalSec))),
                              DataCell(Text(_formatSeconds(a.avgDurationSec))),
                              DataCell(Text('${(a.avgConfidence * 100).toStringAsFixed(1)}%')),
                            ]))
                        .toList(),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          VidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const VidCardHeader(title: 'Action distribution'),
                const Text('Scene count per action.',
                    style: TextStyle(color: VidColors.neutral500, fontSize: 12)),
                const SizedBox(height: 16),
                BarChart(
                  colors: _actionColors,
                  data: r.actionRows
                      .map((a) => ChartDatum(label: a.action, value: a.count))
                      .toList(),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          VidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const VidCardHeader(title: 'Time spent per action'),
                const Text('Minutes of video attributed to each action.',
                    style: TextStyle(color: VidColors.neutral500, fontSize: 12)),
                const SizedBox(height: 16),
                BarChart(
                  colors: _actionColors,
                  data: r.actionRows
                      .map((a) => ChartDatum(
                            label: a.action,
                            value: (a.totalSec / 60 * 10).round() / 10,
                          ))
                      .toList(),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          LayoutBuilder(builder: (context, constraints) {
            final sourceCard = VidCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const VidCardHeader(title: 'Classification source'),
                  const Text(
                    'How each scene\'s action was decided — the CNN alone, a keyword rule, '
                    'or CNN + OCR fusion.',
                    style: TextStyle(color: VidColors.neutral500, fontSize: 12, height: 1.5),
                  ),
                  const SizedBox(height: 16),
                  DonutChart(
                    data: r.sourceCounts.entries
                        .map((e) =>
                            ChartDatum(label: _sourceLabels[e.key] ?? e.key, value: e.value))
                        .toList(),
                  ),
                ],
              ),
            );
            final perLogCard = VidCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const VidCardHeader(title: 'Scenes per log'),
                  const Text(
                    'Spot outlier logs that dominate the aggregate numbers above.',
                    style: TextStyle(color: VidColors.neutral500, fontSize: 12),
                  ),
                  const SizedBox(height: 16),
                  HorizontalBarChart(
                    data: r.perLog
                        .map((v) =>
                            ChartDatum(label: v.$1, value: v.$2, hint: '${v.$2} scenes'))
                        .toList(),
                  ),
                ],
              ),
            );

            if (constraints.maxWidth < 860) {
              return Column(
                  children: [sourceCard, const SizedBox(height: 16), perLogCard]);
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: sourceCard),
                const SizedBox(width: 16),
                Expanded(flex: 2, child: perLogCard),
              ],
            );
          }),
        ],
      ],
    );
  }

  // ── SPM tab ──

  Widget _buildSpmTab() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 620),
          child: VidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                LogSelectList(
                  jobs: _doneLogs,
                  selected: _spmSelection,
                  onChanged: (next) => setState(() {
                    _spmSelection
                      ..clear()
                      ..addAll(next);
                  }),
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(child: _spmOpts.supportField()),
                    const SizedBox(width: 12),
                    Expanded(child: _spmOpts.topKField()),
                  ],
                ),
                const SizedBox(height: 10),
                _AdvancedToggle(
                  expanded: _spmAdvanced,
                  onTap: () => setState(() => _spmAdvanced = !_spmAdvanced),
                ),
                if (_spmAdvanced) ...[
                  const SizedBox(height: 10),
                  _spmOpts.advancedFields(),
                  const SizedBox(height: 10),
                  Row(
                    children: [
                      const Text('Sort by',
                          style: TextStyle(color: VidColors.neutral500, fontSize: 13)),
                      const SizedBox(width: 12),
                      DropdownButton<String>(
                        value: _spmSortBy,
                        dropdownColor: VidColors.surface,
                        onChanged: (v) => setState(() => _spmSortBy = v ?? 's_support'),
                        items: const [
                          DropdownMenuItem(value: 's_support', child: Text('S-support')),
                          DropdownMenuItem(value: 'i_support', child: Text('I-support')),
                        ],
                      ),
                    ],
                  ),
                ],
                const SizedBox(height: 16),
                Row(
                  children: [
                    FilledButton.icon(
                      onPressed: _spmRunning ? null : _runSpm,
                      icon: _spmRunning
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2, color: VidColors.ink))
                          : const Icon(Icons.play_arrow, size: 18),
                      label: Text(_spmRunning ? 'Mining…' : 'Find patterns'),
                    ),
                    if (_spmResults != null && _spmResults!.isNotEmpty) ...[
                      const SizedBox(width: 8),
                      OutlinedButton.icon(
                        onPressed: _exportSpm,
                        icon: const Icon(Icons.download, size: 18),
                        label: const Text('Export CSV'),
                      ),
                    ],
                  ],
                ),
                if (_spmError != null) ...[
                  const SizedBox(height: 12),
                  DangerAlert(message: _spmError!),
                ],
              ],
            ),
          ),
        ),
        if (_spmResults != null) ...[
          const SizedBox(height: 20),
          if (_spmResults!.isEmpty)
            const EmptyStateWidget(
              title: 'No patterns cleared the thresholds',
              subtitle:
                  'Try lowering the S-support threshold, widening the pattern length range, or allowing a bigger max gap.',
            )
          else
            VidCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  VidCardHeader(
                    title: 'Patterns',
                    action: VidBadge(
                        label: '${_spmResults!.length} found', tone: BadgeTone.primary),
                  ),
                  const Text(
                    'S-support is how many of the selected logs contain the pattern at all. '
                    'I-support is how many times it occurs per log on average, counting logs where it never occurs.',
                    style: TextStyle(color: VidColors.neutral500, fontSize: 12, height: 1.5),
                  ),
                  const SizedBox(height: 12),
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: DataTable(
                      columnSpacing: 26,
                      columns: const [
                        DataColumn(label: Text('Pattern')),
                        DataColumn(label: Text('S-freq')),
                        DataColumn(label: Text('S-support')),
                        DataColumn(label: Text('I-freq')),
                        DataColumn(label: Text('I-support (mean)')),
                        DataColumn(label: Text('sd')),
                      ],
                      rows: _spmResults!
                          .map((p) => DataRow(cells: [
                                DataCell(_PatternChips(pattern: p.pattern)),
                                DataCell(Text('${p.support}')),
                                DataCell(
                                    Text('${(p.supportFraction * 100).toStringAsFixed(0)}%')),
                                DataCell(Text('${p.iFrequency}')),
                                DataCell(Text(p.iSupportMean.toStringAsFixed(2))),
                                DataCell(Text(p.iSupportSd.toStringAsFixed(2))),
                              ]))
                          .toList(),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ],
    );
  }

  // ── DSM tab ──

  Widget _buildDsmTab() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        VidCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                'Compare two sets of logs — for example high- vs low-performing sessions. '
                'Each group\'s own frequent patterns are mined, then tested for a significant '
                'difference in how often they occur between the groups.',
                style: TextStyle(color: VidColors.neutral500, fontSize: 13, height: 1.5),
              ),
              const SizedBox(height: 16),
              LayoutBuilder(builder: (context, constraints) {
                final wide = constraints.maxWidth > 760;
                // A log in one group is greyed out and unselectable in the
                // other. Blocking it here means the two groups can never
                // overlap in the first place, rather than letting an
                // invalid selection be built and rejected on submit.
                final a = LogSelectList(
                  label: 'Group A',
                  jobs: _doneLogs,
                  selected: _groupA,
                  disabled: _groupB,
                  disabledHint: 'Already in group B',
                  onChanged: (next) => setState(() {
                    _groupA
                      ..clear()
                      ..addAll(next);
                  }),
                );
                final b = LogSelectList(
                  label: 'Group B',
                  jobs: _doneLogs,
                  selected: _groupB,
                  disabled: _groupA,
                  disabledHint: 'Already in group A',
                  onChanged: (next) => setState(() {
                    _groupB
                      ..clear()
                      ..addAll(next);
                  }),
                );
                if (!wide) return Column(children: [a, const SizedBox(height: 16), b]);
                return Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: a),
                    const SizedBox(width: 20),
                    Expanded(child: b),
                  ],
                );
              }),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(child: _dsmOpts.supportField()),
                  const SizedBox(width: 12),
                  Expanded(child: _dsmOpts.topKField()),
                  const SizedBox(width: 12),
                  Expanded(
                    child: _LabeledField(
                      label: 'p-value threshold',
                      child: TextField(
                        controller: _pValueController,
                        keyboardType: TextInputType.number,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              _LabeledField(
                label: 'Statistical test',
                child: DropdownButtonFormField<String>(
                  initialValue: _testTypes.contains(_testType) ? _testType : _testTypes.first,
                  isExpanded: true,
                  dropdownColor: VidColors.surface,
                  onChanged: (v) => setState(() => _testType = v ?? 'ttest_ind'),
                  items: _testTypes
                      .map((t) => DropdownMenuItem(value: t, child: Text(t)))
                      .toList(),
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'Tests compare each pattern\'s per-log occurrence counts between the two groups. '
                'Some (mood, ansari) test spread rather than average — which test is appropriate is your call.',
                style: TextStyle(color: VidColors.neutral500, fontSize: 12, height: 1.5),
              ),
              const SizedBox(height: 10),
              _AdvancedToggle(
                expanded: _dsmAdvanced,
                onTap: () => setState(() => _dsmAdvanced = !_dsmAdvanced),
              ),
              if (_dsmAdvanced) ...[
                const SizedBox(height: 10),
                _dsmOpts.advancedFields(),
              ],
              const SizedBox(height: 16),
              Row(
                children: [
                  FilledButton.icon(
                    onPressed: _dsmRunning ? null : _runDsm,
                    icon: _dsmRunning
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2, color: VidColors.ink))
                        : const Icon(Icons.compare_arrows, size: 18),
                    label: Text(_dsmRunning ? 'Comparing…' : 'Compare groups'),
                  ),
                  if (_dsmResults != null && _dsmResults!.isNotEmpty) ...[
                    const SizedBox(width: 8),
                    OutlinedButton.icon(
                      onPressed: _exportDsm,
                      icon: const Icon(Icons.download, size: 18),
                      label: const Text('Export CSV'),
                    ),
                  ],
                ],
              ),
              if (_dsmError != null) ...[
                const SizedBox(height: 12),
                DangerAlert(message: _dsmError!),
              ],
            ],
          ),
        ),
        if (_dsmResults != null) ...[
          const SizedBox(height: 20),
          if (_dsmResults!.isEmpty)
            const EmptyStateWidget(
              title: 'No significantly different patterns',
              subtitle:
                  'Nothing cleared the p-value threshold. Try raising it, lowering the S-support threshold, or comparing groups that differ more.',
            )
          else
            VidCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  VidCardHeader(
                    title: 'Differential patterns',
                    action:
                        VidBadge(label: '${_dsmResults!.length} found', tone: BadgeTone.primary),
                  ),
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: DataTable(
                      columnSpacing: 26,
                      columns: const [
                        DataColumn(label: Text('Pattern')),
                        DataColumn(label: Text('p-value')),
                        DataColumn(label: Text('I-support A')),
                        DataColumn(label: Text('I-support B')),
                        DataColumn(label: Text('Characteristic of')),
                      ],
                      rows: _dsmResults!
                          .map((p) => DataRow(cells: [
                                DataCell(_PatternChips(pattern: p.pattern)),
                                DataCell(Text(p.pValue < 0.001
                                    ? p.pValue.toStringAsExponential(2)
                                    : p.pValue.toStringAsFixed(4))),
                                DataCell(Text(p.isupportLeftMean?.toStringAsFixed(2) ?? '—')),
                                DataCell(Text(p.isupportRightMean?.toStringAsFixed(2) ?? '—')),
                                DataCell(VidBadge(
                                  label: p.group == 'left' ? 'Group A' : 'Group B',
                                  tone: p.group == 'left'
                                      ? BadgeTone.primary
                                      : BadgeTone.secondary,
                                )),
                              ]))
                          .toList(),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ],
    );
  }

  // ── Timeline tab ──

  Widget _buildTimelineTab() {
    final selected = _doneLogs.where((j) => _timelineSelection.contains(j.jobId)).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 700),
          child: VidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const VidCardHeader(title: 'Select logs'),
                LogSelectList(
                  jobs: _doneLogs,
                  selected: _timelineSelection,
                  onChanged: (next) => setState(() {
                    _timelineSelection
                      ..clear()
                      ..addAll(next);
                  }),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 20),
        if (selected.isEmpty)
          const EmptyStateWidget(title: 'Select one or more logs to see their timelines')
        else
          ...selected.map((job) => Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: _TimelineCard(job: job, colors: _actionColors),
              )),
      ],
    );
  }
}

/// Holds the numeric option fields for one mining tab, so SPM and DSM can
/// each own an independent set without duplicating the widget code.
class _OptionControllers {
  final minSupport = TextEditingController(text: '0.4');
  final topK = TextEditingController(text: '10');
  final windowMin = TextEditingController(text: '1');
  final windowMax = TextEditingController(text: '4');
  final minGap = TextEditingController(text: '0');
  final maxGap = TextEditingController(text: '12');
  final minInstanceSupport = TextEditingController(text: '0');

  MiningOptions build() => MiningOptions(
        minSupport: double.tryParse(minSupport.text.trim()) ?? 0.4,
        topK: int.tryParse(topK.text.trim()) ?? 10,
        slidingWindowMin: int.tryParse(windowMin.text.trim()) ?? 1,
        slidingWindowMax: int.tryParse(windowMax.text.trim()) ?? 4,
        minGap: int.tryParse(minGap.text.trim()) ?? 0,
        // Blank means "unlimited" — the sidecar treats a null max_gap as
        // plain PrefixSpan matching.
        maxGap: maxGap.text.trim().isEmpty ? null : int.tryParse(maxGap.text.trim()),
        minInstanceSupport: double.tryParse(minInstanceSupport.text.trim()) ?? 0.0,
      );

  Widget supportField() =>
      _LabeledField(label: 'S-support threshold', child: _numberField(minSupport));

  Widget topKField() => _LabeledField(label: 'Top K', child: _numberField(topK));

  Widget advancedFields() => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                  child: _LabeledField(
                      label: 'Min pattern length', child: _numberField(windowMin))),
              const SizedBox(width: 12),
              Expanded(
                  child: _LabeledField(
                      label: 'Max pattern length', child: _numberField(windowMax))),
            ],
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: _LabeledField(label: 'Min gap', child: _numberField(minGap))),
              const SizedBox(width: 12),
              Expanded(
                  child: _LabeledField(
                      label: 'Max gap (blank = any)', child: _numberField(maxGap))),
              const SizedBox(width: 12),
              Expanded(
                  child: _LabeledField(
                      label: 'I-support threshold',
                      child: _numberField(minInstanceSupport))),
            ],
          ),
          const SizedBox(height: 8),
          const Text(
            'Gap is how many other actions may sit between two consecutive steps of a pattern. '
            'A max gap keeps patterns to things that actually happened close together.',
            style: TextStyle(color: VidColors.neutral500, fontSize: 12, height: 1.5),
          ),
        ],
      );

  static Widget _numberField(TextEditingController c) =>
      TextField(controller: c, keyboardType: TextInputType.number);

  void dispose() {
    minSupport.dispose();
    topK.dispose();
    windowMin.dispose();
    windowMax.dispose();
    minGap.dispose();
    maxGap.dispose();
    minInstanceSupport.dispose();
  }
}

class _LabeledField extends StatelessWidget {
  const _LabeledField({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: const TextStyle(
                color: VidColors.neutral500, fontSize: 13, fontWeight: FontWeight.w500)),
        const SizedBox(height: 6),
        child,
      ],
    );
  }
}

class _AdvancedToggle extends StatelessWidget {
  const _AdvancedToggle({required this.expanded, required this.onTap});

  final bool expanded;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Icon(expanded ? Icons.expand_less : Icons.expand_more,
                size: 18, color: VidColors.neutral500),
            const SizedBox(width: 6),
            const Text('Advanced options',
                style: TextStyle(
                    color: VidColors.neutral500, fontSize: 13, fontWeight: FontWeight.w500)),
          ],
        ),
      ),
    );
  }
}

/// A mined pattern rendered as its steps with arrows between them, which
/// reads far faster than a comma-joined string in a dense table.
class _PatternChips extends StatelessWidget {
  const _PatternChips({required this.pattern});

  final List<String> pattern;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 420),
      child: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 4,
        runSpacing: 4,
        children: [
          for (var i = 0; i < pattern.length; i++) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: VidColors.neutral100,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(pattern[i],
                  style: const TextStyle(color: VidColors.text, fontSize: 12)),
            ),
            if (i < pattern.length - 1)
              const Icon(Icons.arrow_right_alt, size: 14, color: VidColors.neutral400),
          ],
        ],
      ),
    );
  }
}

class _TimelineCard extends StatelessWidget {
  const _TimelineCard({required this.job, required this.colors});

  final Job job;

  /// The page-wide action → colour map, so an action looks the same here
  /// as it does in the Overview charts and in every other log's timeline.
  final Map<String, Color> colors;

  @override
  Widget build(BuildContext context) {
    final scenes = job.scenes ?? const <Scene>[];

    // Positions come from each scene's real start/end clock times rather
    // than by stacking durations, so pacing and any gaps read correctly.
    final segments = [
      for (final s in scenes)
        TimelineSegment(
          label: s.action,
          startSec: _parseHms(s.startTime),
          endSec: _parseHms(s.endTime),
          detail: '${(s.confidence * 100).toStringAsFixed(0)}% · '
              '${_sourceLabels[s.source] ?? s.source}',
        )
    ];
    final total = segments.isEmpty
        ? 1.0
        : segments.map((s) => s.endSec).reduce((a, b) => a > b ? a : b);

    return VidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          VidCardHeader(
            title: job.label,
            action: Text(
              '${scenes.length} scenes · ${_formatSeconds(total)}',
              style: const TextStyle(color: VidColors.neutral500, fontSize: 13),
            ),
          ),
          if (segments.isEmpty)
            const Text('No scenes in this log.',
                style: TextStyle(color: VidColors.neutral500, fontSize: 13))
          else
            GanttTimeline(
              segments: segments,
              totalSeconds: total,
              colors: colors,
            ),
        ],
      ),
    );
  }
}
