/// Job detail screen: polls GET /jobs/{id} while queued/processing, then
/// renders the scene log and offers a CSV export (written straight to disk
/// via a native save dialog, see _exportCsv below).
library;

import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../models/job.dart';
import '../services/api_client.dart';
import '../theme/colors.dart';
import '../widgets/progress.dart';

class JobDetailScreen extends StatefulWidget {
  const JobDetailScreen({
    super.key,
    required this.apiClient,
    required this.jobId,
  });

  final ApiClient apiClient;
  final String jobId;

  @override
  State<JobDetailScreen> createState() => _JobDetailScreenState();
}

class _JobDetailScreenState extends State<JobDetailScreen> {
  Job? _job;
  String? _error;
  Timer? _pollTimer;
  bool _exporting = false;
  String? _exportMessage;

  @override
  void initState() {
    super.initState();
    _load();
    _pollTimer = Timer.periodic(const Duration(milliseconds: 1500), (_) {
      final status = _job?.status;
      if (status == JobStatus.queued || status == JobStatus.processing || _job == null) {
        _load();
      }
    });
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final job = await widget.apiClient.getJob(widget.jobId);
      if (!mounted) return;
      setState(() {
        _job = job;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '$e');
    }
  }

  Future<void> _exportCsv() async {
    final job = _job;
    if (job == null || job.status != JobStatus.done) return;
    setState(() {
      _exporting = true;
      _exportMessage = null;
    });
    try {
      final bytes = await widget.apiClient.getJobCsv(job.jobId);
      final suggested = widget.apiClient.suggestedCsvFilename(job);
      final savePath = await FilePicker.platform.saveFile(
        dialogTitle: 'Save scene log CSV',
        fileName: suggested,
        type: FileType.custom,
        allowedExtensions: ['csv'],
      );
      if (savePath == null) return; // user cancelled
      await File(savePath).writeAsBytes(bytes);
      if (!mounted) return;
      setState(() => _exportMessage = 'Saved to $savePath');
    } catch (e) {
      if (!mounted) return;
      setState(() => _exportMessage = 'Export failed: $e');
    } finally {
      if (mounted) setState(() => _exporting = false);
    }
  }

  Future<void> _rename() async {
    final job = _job;
    if (job == null) return;
    final controller = TextEditingController(text: job.label);
    final newName = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename job'),
        content: TextField(controller: controller, autofocus: true),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(controller.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (newName == null || newName.trim().isEmpty) return;
    try {
      final updated = await widget.apiClient.renameJob(job.jobId, newName.trim());
      if (!mounted) return;
      setState(() => _job = updated);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final job = _job;
    return Scaffold(
      appBar: AppBar(
        title: Text(job?.label ?? 'Job'),
        actions: [
          if (job != null)
            IconButton(
              tooltip: 'Rename',
              onPressed: _rename,
              icon: const Icon(Icons.edit_outlined),
            ),
        ],
      ),
      body: _buildBody(job),
    );
  }

  Widget _buildBody(Job? job) {
    if (job == null && _error != null) {
      return Center(child: Text('$_error'));
    }
    if (job == null) {
      return const Center(child: CircularProgressIndicator());
    }

    switch (job.status) {
      case JobStatus.queued:
      case JobStatus.processing:
        return Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const CircularProgressIndicator(),
              const SizedBox(height: 16),
              Text(job.status == JobStatus.queued ? 'Queued…' : 'Processing…'),
              const SizedBox(height: 4),
              Text(
                'Running locally, this can take a while for longer videos.',
                style: TextStyle(color: VidColors.neutral500, fontSize: 12),
              ),
              if (job.status == JobStatus.processing) ...[
                const SizedBox(height: 16),
                const SizedBox(width: 220, child: VidProgressBar()),
              ],
            ],
          ),
        );
      case JobStatus.failed:
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.error_outline, size: 40, color: VidColors.danger),
                const SizedBox(height: 12),
                Text(job.error ?? 'Job failed.', textAlign: TextAlign.center),
              ],
            ),
          ),
        );
      case JobStatus.done:
        final scenes = job.scenes ?? [];
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Text('${job.sceneCount ?? scenes.length} scenes'),
                  const Spacer(),
                  if (_exportMessage != null)
                    Flexible(
                      child: Text(
                        _exportMessage!,
                        style: TextStyle(color: VidColors.neutral500, fontSize: 12),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  const SizedBox(width: 12),
                  FilledButton.icon(
                    onPressed: _exporting ? null : _exportCsv,
                    icon: _exporting
                        ? const SizedBox(
                            width: 14,
                            height: 14,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.download),
                    label: const Text('Export CSV'),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: DataTable(
                  columns: const [
                    DataColumn(label: Text('Start')),
                    DataColumn(label: Text('End')),
                    DataColumn(label: Text('Duration')),
                    DataColumn(label: Text('Action')),
                    DataColumn(label: Text('Confidence')),
                    DataColumn(label: Text('Source')),
                  ],
                  rows: scenes
                      .map(
                        (s) => DataRow(
                          cells: [
                            DataCell(Text(s.startTime)),
                            DataCell(Text(s.endTime)),
                            DataCell(Text(s.duration)),
                            DataCell(Text(s.action)),
                            DataCell(Text(s.confidence.toStringAsFixed(2))),
                            DataCell(Text(s.source)),
                          ],
                        ),
                      )
                      .toList(),
                ),
              ),
            ),
          ],
        );
    }
  }
}
