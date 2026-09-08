/// Ported from frontend/app/video-logs/page.tsx, every finished video
/// log: view scenes inline, rename, export CSV, delete, plus importing a
/// log that already exists as a CSV (produced by hand, exported from
/// elsewhere, or exported from here and edited).
///
/// Combining several logs into one CSV is built here rather than on the
/// sidecar: the file is assembled from scene rows this screen already has,
/// keyed by a `user_id` column carrying each log's name, which is what lets
/// the combined file be re-imported and split back into the same logs.
library;

import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../constants/copy.dart';
import '../constants/help_content.dart';
import '../models/job.dart';
import '../services/api_client.dart';
import '../utils/log_csv.dart';
import '../widgets/ui.dart';

class VideoLogsScreen extends StatefulWidget {
  const VideoLogsScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<VideoLogsScreen> createState() => _VideoLogsScreenState();
}

class _VideoLogsScreenState extends State<VideoLogsScreen> {
  List<Job>? _jobs;
  String? _error;
  String? _expandedJobId;
  String? _renamingJobId;
  final _renameController = TextEditingController();
  bool _busy = false;
  bool _importing = false;

  // Errors are a list rather than one string: a spreadsheet usually repeats
  // the same mistake on many rows, and showing them together lets the whole
  // file be fixed in one pass instead of one failed import at a time.
  List<String> _importErrors = const [];
  List<String> _importNotices = const [];
  String? _importSummary;

  /// Whether [_importErrors] are about the file's SHAPE (so the format rules
  /// are worth restating) or about saving failing (where they are not, and
  /// repeating them would send someone off to edit a file that was fine).
  bool _importErrorsAreFormat = true;

  /// Logs ticked for combining into a single CSV.
  final Set<String> _combineSelection = {};
  bool _combining = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _renameController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final jobs = await widget.apiClient.listJobs();
      if (!mounted) return;
      setState(() {
        _jobs = jobs.where((j) => j.status == JobStatus.done).toList();
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '$e');
    }
  }

  Future<void> _exportCsv(Job job) async {
    setState(() => _busy = true);
    try {
      final bytes = await widget.apiClient.getJobCsv(job.jobId);
      final savePath = await FilePicker.platform.saveFile(
        dialogTitle: 'Save scene log CSV',
        fileName: widget.apiClient.suggestedCsvFilename(job),
        type: FileType.custom,
        allowedExtensions: ['csv'],
      );
      if (savePath == null) return;
      await File(savePath).writeAsBytes(bytes);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Reads the chosen CSV here, repairs what can be repaired (see
  /// utils/log_csv.dart), and hands the sidecar one canonical CSV per log it
  /// found. A file carrying a `user_id` column is a combined export and
  /// becomes several logs, one per id, each named after that id.
  Future<void> _importCsv() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['csv'],
      dialogTitle: 'Choose a log CSV to import',
    );
    final path = result?.files.single.path;
    if (path == null) return;

    setState(() {
      _importErrors = const [];
      _importNotices = const [];
      _importSummary = null;
      _importErrorsAreFormat = true;
    });

    final String text;
    try {
      text = await File(path).readAsString();
    } catch (e) {
      setState(() => _importErrors = ['Could not read that file: $e']);
      return;
    }

    final baseName = path.split(Platform.pathSeparator).last.replaceFirst(RegExp(r'\.[^.]+$'), '');
    final parsed = parseLogCsv(text, baseName.isEmpty ? 'Imported log' : baseName);
    if (!parsed.ok) {
      setState(() {
        _importErrors = parsed.errors;
        _importNotices = parsed.notices;
      });
      return;
    }

    setState(() => _importing = true);
    final imported = <String>[];
    final failed = <String>[];
    // Canonical copies live in a temp folder; the sidecar records the path
    // it imported from, and a scratch file is more honest than pretending
    // the original spreadsheet was in this exact shape.
    final tempDir = await Directory.systemTemp.createTemp('vid2log_import_');
    try {
      for (final log in parsed.logs) {
        final safeName = log.name.replaceAll(RegExp(r'[/\\:*?"<>|]'), '_');
        final file = File('${tempDir.path}${Platform.pathSeparator}$safeName.csv');
        await file.writeAsString(buildCanonicalCsv(log.scenes));
        try {
          final job = await widget.apiClient.importCsvLog(file.path);
          // The sidecar names the log after the file it read; set the display
          // name too so a combined import shows "P01" rather than "P01.csv".
          await widget.apiClient.renameJob(job.jobId, log.name);
          imported.add(log.name);
        } catch (e) {
          failed.add('${log.name}: $e');
        }
      }
      await _load();
      if (!mounted) return;
      setState(() {
        _importErrorsAreFormat = false;
        _importErrors = failed;
        if (imported.isNotEmpty) {
          _importSummary = parsed.logs.length > 1
              ? 'Imported ${imported.length} log${imported.length > 1 ? 's' : ''}: ${imported.join(', ')}.'
              : 'Imported ${imported.first}.';
          _importNotices = parsed.notices;
        }
      });
    } finally {
      if (mounted) setState(() => _importing = false);
      // Best effort: the OS clears its temp folder anyway.
      try {
        await tempDir.delete(recursive: true);
      } catch (_) {}
    }
  }

  /// Builds one CSV holding every selected log, keyed by a `user_id` column
  /// carrying the log's name so the file round-trips back through import.
  Future<void> _combineSelected() async {
    setState(() => _combining = true);
    try {
      final selected = (_jobs ?? []).where((j) => _combineSelection.contains(j.jobId)).toList();
      final logs = <ParsedLog>[];
      for (final job in selected) {
        final full = await widget.apiClient.getJob(job.jobId);
        logs.add(ParsedLog(
          name: job.label.replaceFirst(RegExp(r'\.[^.]+$'), ''),
          scenes: [
            for (final s in full.scenes ?? const <Scene>[])
              NormalisedScene(
                startTime: s.startTime,
                endTime: s.endTime,
                duration: s.duration,
                action: s.action,
                confidence: s.confidence,
                source: s.source.isEmpty ? 'csv_import' : s.source,
              ),
          ],
        ));
      }
      final savePath = await FilePicker.platform.saveFile(
        dialogTitle: 'Save combined log CSV',
        fileName: 'combined_logs.csv',
        type: FileType.custom,
        allowedExtensions: ['csv'],
      );
      if (savePath == null) return;
      await File(savePath).writeAsString(buildCombinedCsv(logs));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _combining = false);
    }
  }

  /// Writes a short example CSV showing the shape an importable log needs.
  /// Only the four columns a person must actually fill in: confidence and
  /// source are optional on import, so asking for them invites confusion.
  Future<void> _downloadTemplate() async {
    final savePath = await FilePicker.platform.saveFile(
      dialogTitle: 'Save CSV template',
      fileName: 'vid2log_log_template.csv',
      type: FileType.custom,
      allowedExtensions: ['csv'],
    );
    if (savePath == null) return;
    try {
      await File(savePath).writeAsString(buildTemplateCsv());
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  void _startRename(Job job) {
    setState(() {
      _renamingJobId = job.jobId;
      _renameController.text = job.label;
    });
  }

  Future<void> _commitRename(Job job) async {
    final name = _renameController.text.trim();
    if (name.isEmpty) return;
    try {
      await widget.apiClient.renameJob(job.jobId, name);
      setState(() => _renamingJobId = null);
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _delete(Job job) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this video log?'),
        content: Text(
            'This permanently deletes the log for "${job.label}". This can\'t be undone.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: VidColors.danger, foregroundColor: Colors.white),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete log'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await widget.apiClient.deleteJob(job.jobId);
      if (_expandedJobId == job.jobId) _expandedJobId = null;
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PageHeader(
            eyebrow: 'Video logs',
            helpSection: kHelpAnchors.videoLogs,
            subtitle: kPageSubtitles['video-logs'],
            title: 'Video logs',
            action: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (_combineSelection.length >= 2) ...[
                  OutlinedButton.icon(
                    onPressed: _combining ? null : _combineSelected,
                    icon: _combining
                        ? const SizedBox(
                            width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.merge_rounded, size: 18),
                    label: Text(_combining
                        ? 'Combining…'
                        : 'Combine ${_combineSelection.length} logs'),
                  ),
                  const SizedBox(width: 8),
                ],
                TextButton(onPressed: _downloadTemplate, child: const Text('CSV template')),
                const SizedBox(width: 8),
                Tooltip(
                  message: kButtonTooltips['importCsv']!,
                  child: OutlinedButton.icon(
                    onPressed: _importing ? null : _importCsv,
                    icon: _importing
                        ? const SizedBox(
                            width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Icon(Icons.upload_file_rounded, size: 18),
                    label: Text(_importing ? 'Importing…' : 'Import CSV log'),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(bottom: 16),
            child: Text(
              'Already have a log? Import it as a CSV instead of processing a video.',
              style: TextStyle(color: VidColors.neutral500, fontSize: 13),
            ),
          ),
          if (_importErrors.isNotEmpty) ...[
            _ImportProblems(
              errors: _importErrors,
              isFormatProblem: _importErrorsAreFormat,
              onDismiss: () => setState(() => _importErrors = const []),
            ),
            const SizedBox(height: 16),
          ],
          if (_importSummary != null) ...[
            _ImportSummary(
              summary: _importSummary!,
              notices: _importNotices,
              onDismiss: () => setState(() {
                _importSummary = null;
                _importNotices = const [];
              }),
            ),
            const SizedBox(height: 16),
          ],
          if (_error != null) ...[DangerAlert(message: _error!), const SizedBox(height: 16)],
          if (_jobs == null)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 60),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_jobs!.isEmpty)
            const EmptyStateWidget(title: 'No logs yet')
          else
            ..._jobs!.map(_buildJobCard),
        ],
      ),
    );
  }

  Widget _buildJobCard(Job job) {
    final isExpanded = _expandedJobId == job.jobId;
    final isRenaming = _renamingJobId == job.jobId;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: VidCard(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                // Ticking two or more enables the combine action in the header.
                Tooltip(
                  message: 'Include this log when combining',
                  waitDuration: const Duration(milliseconds: 400),
                  child: Checkbox(
                    value: _combineSelection.contains(job.jobId),
                    onChanged: (v) => setState(() {
                      if (v == true) {
                        _combineSelection.add(job.jobId);
                      } else {
                        _combineSelection.remove(job.jobId);
                      }
                    }),
                  ),
                ),
                Expanded(
                  child: isRenaming
                      ? Row(
                          children: [
                            Expanded(
                              child: TextField(
                                controller: _renameController,
                                autofocus: true,
                                onSubmitted: (_) => _commitRename(job),
                              ),
                            ),
                            const SizedBox(width: 8),
                            TextButton(onPressed: () => _commitRename(job), child: const Text('Save')),
                            TextButton(
                                onPressed: () => setState(() => _renamingJobId = null),
                                child: const Text('Cancel')),
                          ],
                        )
                      : Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(job.label,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(color: VidColors.text, fontWeight: FontWeight.w500)),
                            const SizedBox(height: 2),
                            Text(
                              job.sceneCount != null ? '${job.sceneCount} scenes' : 'N/A',
                              style: TextStyle(color: VidColors.neutral500, fontSize: 13),
                            ),
                          ],
                        ),
                ),
              ],
            ),
            if (!isRenaming) ...[
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  TextButton(
                    onPressed: () => setState(() => _expandedJobId = isExpanded ? null : job.jobId),
                    child: Text(isExpanded ? 'Hide log' : 'View log'),
                  ),
                  Tooltip(
                    message: kButtonTooltips['exportCsv']!,
                    child: OutlinedButton(
                      onPressed: _busy ? null : () => _exportCsv(job),
                      child: const Text('Download CSV'),
                    ),
                  ),
                  OutlinedButton(onPressed: () => _startRename(job), child: const Text('Rename')),
                  OutlinedButton(
                    style: OutlinedButton.styleFrom(foregroundColor: VidColors.danger, side: BorderSide(color: VidColors.danger)),
                    onPressed: () => _delete(job),
                    child: const Text('Delete'),
                  ),
                ],
              ),
            ],
            if (isExpanded && job.scenes != null) ...[
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Divider(height: 1, color: VidColors.neutral200),
              ),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 320),
                child: SingleChildScrollView(
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: DataTable(
                      columns: const [
                        DataColumn(label: Text('Start')),
                        DataColumn(label: Text('End')),
                        DataColumn(label: Text('Duration')),
                        DataColumn(label: Text('Action')),
                        DataColumn(label: Text('Confidence')),
                      ],
                      rows: job.scenes!
                          .map((s) => DataRow(cells: [
                                DataCell(Text(s.startTime)),
                                DataCell(Text(s.endTime)),
                                DataCell(Text(s.duration)),
                                DataCell(Text(s.action)),
                                DataCell(Text('${(s.confidence * 100).toStringAsFixed(1)}%')),
                              ]))
                          .toList(),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// The list of reasons an import was rejected, with the rule restated so the
/// file can be fixed in one pass rather than by trial and error.
/// Small close affordance shared by the import banners, so a dismissed banner
/// looks and behaves the same whether the import succeeded or failed.
class _DismissButton extends StatelessWidget {
  const _DismissButton({
    required this.color,
    required this.tooltip,
    required this.onPressed,
  });

  final Color color;
  final String tooltip;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        label: tooltip,
        child: InkWell(
          onTap: onPressed,
          borderRadius: BorderRadius.circular(6),
          child: Padding(
            padding: const EdgeInsets.all(2),
            child: Icon(Icons.close, size: 16, color: color.withValues(alpha: 0.7)),
          ),
        ),
      ),
    );
  }
}

class _ImportProblems extends StatelessWidget {
  const _ImportProblems({
    required this.errors,
    required this.isFormatProblem,
    required this.onDismiss,
  });

  final List<String> errors;

  /// False when the file parsed fine and only saving failed, in which case
  /// restating the column rules would misdirect the reader.
  final bool isFormatProblem;

  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: VidColors.dangerTint,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(
                  isFormatProblem
                      ? 'This CSV could not be imported. Fix the following and try again:'
                      : 'The file was read correctly, but these logs could not be saved:',
                  style: TextStyle(
                      color: VidColors.danger, fontSize: 13, fontWeight: FontWeight.w600),
                ),
              ),
              _DismissButton(
                color: VidColors.danger,
                tooltip: 'Dismiss import errors',
                onPressed: onDismiss,
              ),
            ],
          ),
          const SizedBox(height: 6),
          for (final e in errors)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text('•  $e',
                  style: TextStyle(color: VidColors.danger, fontSize: 13, height: 1.45)),
            ),
          if (isFormatProblem) ...[
            const SizedBox(height: 8),
            Text(
              'The file needs an "action" column and any two of "start_time", "end_time" '
              'and "duration". Column order and capitalisation do not matter.',
              style: TextStyle(color: VidColors.danger, fontSize: 12, height: 1.45),
            ),
          ],
        ],
      ),
    );
  }
}

/// What an import actually did, including anything that was derived or
/// defaulted, so the result is never silently different from the file.
class _ImportSummary extends StatelessWidget {
  const _ImportSummary({
    required this.summary,
    required this.notices,
    required this.onDismiss,
  });

  final String summary;
  final List<String> notices;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: VidColors.successTint,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Text(summary,
                    style: TextStyle(
                        color: VidColors.success, fontSize: 13, fontWeight: FontWeight.w600)),
              ),
              _DismissButton(
                color: VidColors.success,
                tooltip: 'Dismiss import summary',
                onPressed: onDismiss,
              ),
            ],
          ),
          for (final n in notices)
            Padding(
              padding: const EdgeInsets.only(top: 3),
              child: Text('•  $n',
                  style: TextStyle(color: VidColors.success, fontSize: 12.5, height: 1.45)),
            ),
        ],
      ),
    );
  }
}
