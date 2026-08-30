/// Ported from frontend/app/process/page.tsx, "New job" / "Job history"
/// tabs. Simplified versus the web version in ways that follow directly
/// from being local instead of cloud: no upload step (the video's already
/// a real file on disk, see api_client.dart's createJob docstring), and
/// "Cancel" on a queued job just deletes it (the sidecar has no separate
/// cancel endpoint, but DELETE on a queued job achieves the same thing,
/// see python_sidecar/app/main.py's 409-only-while-processing guard). The
/// sidecar doesn't report per-video progress, so a processing job only
/// gets an indeterminate bar, no percentage.
library;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../models/job.dart';
import '../models/training.dart';
import '../services/api_client.dart';
import '../shell/section.dart';
import '../widgets/progress.dart';
import '../widgets/ui.dart';

enum _ProcessTab { newJob, history }

class ProcessScreen extends StatefulWidget {
  const ProcessScreen({
    super.key,
    required this.apiClient,
    required this.onOpenJob,
    required this.onNavigate,
  });

  final ApiClient apiClient;
  final ValueChanged<String> onOpenJob;
  final ValueChanged<AppSection> onNavigate;

  @override
  State<ProcessScreen> createState() => _ProcessScreenState();
}

class _ProcessScreenState extends State<ProcessScreen> {
  _ProcessTab _tab = _ProcessTab.newJob;

  String? _videoPath;
  String? _videoName;
  final _fpsController = TextEditingController(text: '2');
  bool _submitting = false;
  String? _submitError;

  List<Job>? _jobs;
  String? _jobsError;

  /// null = "Use active model" (the sidecar resolves it at job-creation
  /// time, see main.py's create_job), matching the web app's default
  /// dropdown option.
  String? _selectedModelId;
  List<ModelInfo>? _models;

  @override
  void initState() {
    super.initState();
    _loadJobs();
    _loadModels();
  }

  Future<void> _loadModels() async {
    try {
      final models = await widget.apiClient.listModels();
      if (!mounted) return;
      setState(() => _models = models);
    } catch (_) {
      // Non-fatal: the picker just falls back to "Use active model", which
      // is the correct default anyway.
      if (!mounted) return;
      setState(() => _models = const []);
    }
  }

  @override
  void dispose() {
    _fpsController.dispose();
    super.dispose();
  }

  Future<void> _loadJobs() async {
    try {
      final jobs = await widget.apiClient.listJobs();
      if (!mounted) return;
      setState(() {
        _jobs = jobs;
        _jobsError = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _jobsError = '$e');
    }
  }

  Future<void> _pickVideo() async {
    final result = await FilePicker.platform.pickFiles(type: FileType.video);
    if (result == null || result.files.isEmpty) return;
    final file = result.files.single;
    if (file.path == null) return;
    setState(() {
      _videoPath = file.path;
      _videoName = file.name;
    });
  }

  Future<void> _submit() async {
    if (_videoPath == null) return;
    final fps = int.tryParse(_fpsController.text.trim()) ?? 2;
    setState(() {
      _submitting = true;
      _submitError = null;
    });
    try {
      final job = await widget.apiClient.createJob(
        videoPath: _videoPath!,
        originalFilename: _videoName,
        fps: fps.clamp(1, 30),
        modelId: _selectedModelId,
      );
      if (!mounted) return;
      setState(() {
        _videoPath = null;
        _videoName = null;
        _tab = _ProcessTab.history;
      });
      await _loadJobs();
      widget.onOpenJob(job.jobId);
    } catch (e) {
      if (!mounted) return;
      setState(() => _submitError = '$e');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _cancelQueued(Job job) async {
    try {
      await widget.apiClient.deleteJob(job.jobId);
      await _loadJobs();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final activeCount = _jobs
            ?.where((j) => j.status == JobStatus.queued || j.status == JobStatus.processing)
            .length ??
        0;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PageHeader(
            eyebrow: 'Process',
            title: 'Process a video',
            action: OutlinedButton(
              onPressed: () => widget.onNavigate(AppSection.videoLogs),
              child: const Text('Video logs'),
            ),
          ),
          VidTabs<_ProcessTab>(
            tabs: [
              (_ProcessTab.newJob, 'New job'),
              (_ProcessTab.history, 'Job history${activeCount > 0 ? ' ($activeCount active)' : ''}'),
            ],
            active: _tab,
            onChange: (t) => setState(() => _tab = t),
          ),
          if (_tab == _ProcessTab.newJob) _buildNewJob() else _buildHistory(),
        ],
      ),
    );
  }

  Widget _buildNewJob() {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 640),
      child: VidCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const VidCardHeader(title: 'New job'),
            Text('Video file', style: TextStyle(color: VidColors.neutral500, fontSize: 13, fontWeight: FontWeight.w500)),
            const SizedBox(height: 6),
            InkWell(
              onTap: _submitting ? null : _pickVideo,
              borderRadius: BorderRadius.circular(10),
              child: Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: VidColors.neutral100,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: VidColors.neutral200),
                ),
                child: Row(
                  children: [
                    Icon(Icons.movie_outlined, color: VidColors.neutral500),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        _videoName ?? 'Choose a video file…',
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: _videoName != null ? VidColors.text : VidColors.neutral500,
                        ),
                      ),
                    ),
                    Icon(Icons.folder_open_rounded, size: 18, color: VidColors.neutral500),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 4),
            Text(
              'Processed entirely on this machine, the file never leaves your disk.',
              style: TextStyle(color: VidColors.neutral500, fontSize: 12),
            ),
            const SizedBox(height: 16),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Model',
                          style: TextStyle(
                              color: VidColors.neutral500, fontSize: 13, fontWeight: FontWeight.w500)),
                      const SizedBox(height: 6),
                      DropdownButtonFormField<String?>(
                        initialValue: _selectedModelId,
                        isExpanded: true,
                        dropdownColor: VidColors.surface,
                        onChanged: _submitting ? null : (v) => setState(() => _selectedModelId = v),
                        items: [
                          const DropdownMenuItem<String?>(
                            value: null,
                            child: Text('Use active model'),
                          ),
                          ...?_models?.map(
                            (m) => DropdownMenuItem<String?>(
                              value: m.modelId,
                              child: Text(
                                '${m.name}${m.isActive ? ' (active)' : ''}',
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 12),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Sampling FPS',
                        style: TextStyle(
                            color: VidColors.neutral500, fontSize: 13, fontWeight: FontWeight.w500)),
                    const SizedBox(height: 6),
                    SizedBox(
                      width: 110,
                      child: TextField(
                        controller: _fpsController,
                        keyboardType: TextInputType.number,
                        enabled: !_submitting,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: (_videoPath == null || _submitting) ? null : _submit,
                icon: _submitting
                    ? SizedBox(
                        width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: VidColors.ink))
                    : const Icon(Icons.play_arrow),
                label: Text(_submitting ? 'Starting…' : 'Process video'),
              ),
            ),
            if (_submitError != null) ...[
              const SizedBox(height: 12),
              DangerAlert(message: _submitError!),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildHistory() {
    if (_jobsError != null && _jobs == null) {
      return DangerAlert(message: _jobsError!);
    }
    if (_jobs == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 60),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_jobs!.isEmpty) {
      return const EmptyStateWidget(title: 'No jobs yet');
    }
    return Column(
      children: _jobs!
          .map((job) => Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: VidCard(
                  padding: const EdgeInsets.all(16),
                  child: InkWell(
                    onTap: () => widget.onOpenJob(job.jobId),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Column(
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
                            StatusBadge(status: job.status),
                            if (job.status == JobStatus.queued) ...[
                              const SizedBox(width: 8),
                              TextButton(
                                onPressed: () => _cancelQueued(job),
                                child: const Text('Cancel'),
                              ),
                            ],
                          ],
                        ),
                        if (job.status == JobStatus.processing) ...[
                          const SizedBox(height: 12),
                          const VidProgressBar(),
                        ],
                        if (job.status == JobStatus.failed && job.error != null) ...[
                          const SizedBox(height: 10),
                          DangerAlert(message: job.error!),
                        ],
                      ],
                    ),
                  ),
                ),
              ))
          .toList(),
    );
  }
}
