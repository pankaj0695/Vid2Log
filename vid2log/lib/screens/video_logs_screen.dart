/// Ported from frontend/app/video-logs/page.tsx — every finished video
/// log: view scenes inline, rename, export CSV, delete, plus importing a
/// log that already exists as a CSV (produced by hand, exported from
/// elsewhere, or exported from here and edited).
///
/// The web version's "combine N logs into one CSV" is the one feature not
/// here yet — it needs a combine endpoint on the sidecar, which is a pure
/// addition rather than a blocker.
library;

import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../models/job.dart';
import '../services/api_client.dart';
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
  String? _importError;

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

  Future<void> _importCsv() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['csv'],
      dialogTitle: 'Choose a log CSV to import',
    );
    final path = result?.files.single.path;
    if (path == null) return;

    setState(() {
      _importing = true;
      _importError = null;
    });
    try {
      await widget.apiClient.importCsvLog(path);
      await _load();
    } catch (e) {
      if (!mounted) return;
      setState(() => _importError = '$e');
    } finally {
      if (mounted) setState(() => _importing = false);
    }
  }

  /// Writes a two-row example CSV so it's obvious what shape an importable
  /// log has — same columns the sidecar requires (see main.py's
  /// REQUIRED_IMPORT_COLUMNS) and the same ones Download CSV exports, so a
  /// template can be filled in and imported directly.
  Future<void> _downloadTemplate() async {
    final savePath = await FilePicker.platform.saveFile(
      dialogTitle: 'Save CSV template',
      fileName: 'vid2log_log_template.csv',
      type: FileType.custom,
      allowedExtensions: ['csv'],
    );
    if (savePath == null) return;
    const template = 'start_time,end_time,duration,action,confidence,source\n'
        '00:00:00,00:00:05,00:00:05,Login Screen,0.95,manual\n'
        '00:00:05,00:00:12,00:00:07,Dashboard,0.91,manual\n';
    try {
      await File(savePath).writeAsString(template);
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
            title: 'Video logs',
            action: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextButton(onPressed: _downloadTemplate, child: const Text('CSV template')),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: _importing ? null : _importCsv,
                  icon: _importing
                      ? const SizedBox(
                          width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.upload_file_rounded, size: 18),
                  label: Text(_importing ? 'Importing…' : 'Import CSV log'),
                ),
              ],
            ),
          ),
          const Padding(
            padding: EdgeInsets.only(bottom: 16),
            child: Text(
              'Already have a log? Import it as a CSV instead of processing a video.',
              style: TextStyle(color: VidColors.neutral500, fontSize: 13),
            ),
          ),
          if (_importError != null) ...[DangerAlert(message: _importError!), const SizedBox(height: 16)],
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
                                style: const TextStyle(color: VidColors.text, fontWeight: FontWeight.w500)),
                            const SizedBox(height: 2),
                            Text(
                              job.sceneCount != null ? '${job.sceneCount} scenes' : '—',
                              style: const TextStyle(color: VidColors.neutral500, fontSize: 13),
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
                  OutlinedButton(
                    onPressed: _busy ? null : () => _exportCsv(job),
                    child: const Text('Download CSV'),
                  ),
                  OutlinedButton(onPressed: () => _startRename(job), child: const Text('Rename')),
                  OutlinedButton(
                    style: OutlinedButton.styleFrom(foregroundColor: VidColors.danger, side: const BorderSide(color: VidColors.danger)),
                    onPressed: () => _delete(job),
                    child: const Text('Delete'),
                  ),
                ],
              ),
            ],
            if (isExpanded && job.scenes != null) ...[
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 12),
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
