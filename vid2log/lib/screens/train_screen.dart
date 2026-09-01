/// Ported from frontend/app/train/page.tsx, "Train" / "Training jobs"
/// tabs. Two differences from the web version, both because this is a
/// desktop app reading the user's own disk rather than a browser uploading
/// to the cloud:
///
///   * Primary dataset input is a FOLDER whose subfolders are action names
///     (POST /train/scan-folder), the layout Teachable-Machine-style
///     datasets already use, and far faster than adding images per action
///     when they're already organised on disk. A per-action "Add images…"
///     picker is still there for tweaking afterwards.
///   * Nothing is uploaded. The dataset is a list of absolute paths the
///     sidecar reads in place (see python_sidecar/app/training_pipeline.py),
///     so there's no upload progress to show, the job starts instantly and
///     progress is all real training progress.
library;

import 'dart:async';
import 'dart:io' show Platform;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../constants/copy.dart';
import '../constants/help_content.dart';
import '../models/job.dart';
import '../models/training.dart';
import '../services/api_client.dart';
import '../widgets/progress.dart';
import '../widgets/ui.dart';

enum _TrainTab { build, jobs }

class TrainScreen extends StatefulWidget {
  const TrainScreen({super.key, required this.apiClient, required this.onOpenModels});

  final ApiClient apiClient;
  final VoidCallback onOpenModels;

  @override
  State<TrainScreen> createState() => _TrainScreenState();
}

class _TrainScreenState extends State<TrainScreen> {
  _TrainTab _tab = _TrainTab.build;

  // ── Dataset being assembled ──
  final List<ScannedAction> _actions = [];
  String? _sourceFolder;
  bool _scanning = false;

  final _modelNameController = TextEditingController();
  final _epochsController = TextEditingController(text: '20');
  final _batchSizeController = TextEditingController(text: '16');
  final _learningRateController = TextEditingController(text: '0.001');
  bool _showAdvanced = false;

  bool _submitting = false;
  String? _formError;

  // ── Training jobs ──
  List<TrainingJob>? _jobs;
  String? _jobsError;
  Timer? _pollTimer;

  @override
  void initState() {
    super.initState();
    _loadJobs();
    // Poll only while something is actually running, see _loadJobs.
    _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) {
      final hasActive = _jobs?.any(
            (j) => j.status == JobStatus.queued || j.status == JobStatus.processing,
          ) ??
          false;
      if (hasActive) _loadJobs();
    });
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _modelNameController.dispose();
    _epochsController.dispose();
    _batchSizeController.dispose();
    _learningRateController.dispose();
    super.dispose();
  }

  Future<void> _loadJobs() async {
    try {
      final jobs = await widget.apiClient.listTrainingJobs();
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

  // ── Dataset assembly ──

  Future<void> _importFolder() async {
    final dir = await FilePicker.platform.getDirectoryPath(
      dialogTitle: 'Choose a dataset folder (one subfolder per action)',
    );
    if (dir == null) return;

    setState(() {
      _scanning = true;
      _formError = null;
    });
    try {
      final scanned = await widget.apiClient.scanDatasetFolder(dir);
      if (!mounted) return;
      setState(() {
        _actions
          ..clear()
          ..addAll(scanned);
        _sourceFolder = dir;
        if (_modelNameController.text.trim().isEmpty) {
          _modelNameController.text = dir.split(Platform.pathSeparator).last;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _formError = '$e');
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  Future<void> _addImagesTo(int index) async {
    final result = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      type: FileType.image,
      dialogTitle: 'Add images to "${_actions[index].name}"',
    );
    if (result == null) return;
    final newPaths = result.files.map((f) => f.path).whereType<String>();
    setState(() {
      final existing = _actions[index].imagePaths;
      // Union, preserving order, re-picking a file the action already has
      // shouldn't duplicate it into the dataset.
      final merged = <String>[...existing, ...newPaths.where((p) => !existing.contains(p))];
      _actions[index] = _actions[index].copyWith(imagePaths: merged);
    });
  }

  /// Pulls a saved action-discovery dataset straight in as the dataset to
  /// train on, the sidecar stores those in subfolder-per-action layout and
  /// returns absolute paths, so this is a pass-through with no conversion
  /// (see create_actions_screen.dart, and main.py's
  /// GET /actions/datasets/{id}).
  Future<void> _importSavedDataset() async {
    List<ActionDataset> datasets;
    try {
      datasets = await widget.apiClient.listActionDatasets();
    } catch (e) {
      if (!mounted) return;
      setState(() => _formError = '$e');
      return;
    }
    if (!mounted) return;
    if (datasets.isEmpty) {
      setState(() => _formError =
          'No saved action sets yet, use Create actions to discover actions from a demo video first.');
      return;
    }

    final chosen = await showDialog<ActionDataset>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Import a saved action set'),
        children: datasets
            .map((d) => SimpleDialogOption(
                  onPressed: () => Navigator.of(context).pop(d),
                  child: Text('${d.name}  (${d.actionCounts.length} actions, ${d.imageCount} images)'),
                ))
            .toList(),
      ),
    );
    if (chosen == null) return;

    setState(() {
      _scanning = true;
      _formError = null;
    });
    try {
      final detail = await widget.apiClient.getActionDataset(chosen.datasetId);
      if (!mounted) return;
      setState(() {
        _actions
          ..clear()
          ..addAll(detail.actions.entries.map(
            (e) => ScannedAction(name: e.key, imageCount: e.value.length, imagePaths: e.value),
          ));
        _sourceFolder = 'saved action set "${detail.name}"';
        if (_modelNameController.text.trim().isEmpty) {
          _modelNameController.text = detail.name;
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _formError = '$e');
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  Future<void> _addEmptyAction() async {
    final controller = TextEditingController();
    final name = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('New action'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'e.g. Login Screen'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(controller.text),
            child: const Text('Add'),
          ),
        ],
      ),
    );
    final trimmed = name?.trim();
    if (trimmed == null || trimmed.isEmpty) return;
    if (_actions.any((a) => a.name == trimmed)) {
      setState(() => _formError = 'There\'s already an action called "$trimmed".');
      return;
    }
    setState(() => _actions.add(ScannedAction(name: trimmed, imageCount: 0, imagePaths: const [])));
  }

  Future<void> _renameAction(int index) async {
    final controller = TextEditingController(text: _actions[index].name);
    final name = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename action'),
        content: TextField(controller: controller, autofocus: true),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(controller.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    final trimmed = name?.trim();
    if (trimmed == null || trimmed.isEmpty) return;
    setState(() => _actions[index] = _actions[index].copyWith(name: trimmed));
  }

  Future<void> _submit() async {
    setState(() => _formError = null);

    final usable = _actions.where((a) => a.imagePaths.isNotEmpty).toList();
    if (usable.length < 2) {
      setState(() => _formError = 'Add at least 2 actions with images before training.');
      return;
    }
    final thin = usable.where((a) => a.imagePaths.length < 3).map((a) => a.name).toList();
    if (thin.isNotEmpty) {
      setState(() => _formError =
          'These actions have fewer than 3 images: ${thin.join(", ")}. Each needs at least 3 so it can be split into train/validation/test.');
      return;
    }

    final name = _modelNameController.text.trim();
    if (name.isEmpty) {
      setState(() => _formError = 'Give the detector a name.');
      return;
    }

    setState(() => _submitting = true);
    try {
      await widget.apiClient.startTraining(
        modelName: name,
        dataset: {for (final a in usable) a.name: a.imagePaths},
        epochs: int.tryParse(_epochsController.text.trim()) ?? 20,
        batchSize: int.tryParse(_batchSizeController.text.trim()) ?? 16,
        learningRate: double.tryParse(_learningRateController.text.trim()) ?? 0.001,
      );
      if (!mounted) return;
      setState(() => _tab = _TrainTab.jobs);
      await _loadJobs();
    } catch (e) {
      if (!mounted) return;
      setState(() => _formError = '$e');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _retry(TrainingJob job) async {
    try {
      await widget.apiClient.retryTraining(job.trainingJobId);
      await _loadJobs();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _deleteJob(TrainingJob job) async {
    try {
      await widget.apiClient.deleteTrainingJob(job.trainingJobId);
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
            eyebrow: 'Train',
            helpSection: kHelpAnchors.train,
            subtitle: kPageSubtitles['train'],
            title: 'Train a detector',
            action: OutlinedButton(
              onPressed: widget.onOpenModels,
              child: const Text('My detectors'),
            ),
          ),
          VidTabs<_TrainTab>(
            tabs: [
              (_TrainTab.build, 'Train a detector', kTrainTabTooltips['train']),
              (_TrainTab.jobs, 'Training sessions${activeCount > 0 ? ' ($activeCount active)' : ''}', kTrainTabTooltips['jobs']),
            ],
            active: _tab,
            onChange: (t) => setState(() => _tab = t),
          ),
          if (_tab == _TrainTab.build) _buildForm() else _buildJobs(),
        ],
      ),
    );
  }

  Widget _buildForm() {
    final usableCount = _actions.where((a) => a.imagePaths.isNotEmpty).length;
    final totalImages = _actions.fold<int>(0, (s, a) => s + a.imagePaths.length);

    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 760),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          VidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const VidCardHeader(title: 'Dataset'),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    FilledButton.icon(
                      onPressed: _scanning ? null : _importFolder,
                      icon: _scanning
                          ? SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2, color: VidColors.ink))
                          : const Icon(Icons.folder_open_rounded, size: 18),
                      label: Text(_scanning ? 'Scanning…' : 'Import folder'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _scanning ? null : _importSavedDataset,
                      icon: const Icon(Icons.auto_awesome_outlined, size: 18),
                      label: const Text('Import action set'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _addEmptyAction,
                      icon: const Icon(Icons.add, size: 18),
                      label: const Text('Add action'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Text(
                  _sourceFolder == null
                      ? 'Import a folder with one subfolder per action, or an action set you built in Create actions. Files are read where they are, nothing is copied or uploaded.'
                      : 'Imported from $_sourceFolder',
                  style: TextStyle(color: VidColors.neutral500, fontSize: 12, height: 1.5),
                ),
                if (_actions.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  ..._actions.asMap().entries.map((e) => _buildActionRow(e.key, e.value)),
                  const SizedBox(height: 12),
                  Text(
                    '$usableCount action${usableCount == 1 ? '' : 's'} · $totalImages image${totalImages == 1 ? '' : 's'}',
                    style: TextStyle(color: VidColors.neutral500, fontSize: 13, fontWeight: FontWeight.w500),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),
          VidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const VidCardHeader(title: 'Detector'),
                FieldLabel('Name', tooltip: kFieldTooltips['detectorName']),
                TextField(
                  controller: _modelNameController,
                  enabled: !_submitting,
                  decoration: const InputDecoration(hintText: 'e.g. Checkout flow v1'),
                ),
                const SizedBox(height: 12),
                InkWell(
                  onTap: () => setState(() => _showAdvanced = !_showAdvanced),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 6),
                    child: Row(
                      children: [
                        Icon(
                          _showAdvanced ? Icons.expand_less : Icons.expand_more,
                          size: 18,
                          color: VidColors.neutral500,
                        ),
                        const SizedBox(width: 6),
                        Text(
                          'Advanced (optional)',
                          style: TextStyle(color: VidColors.neutral500, fontSize: 13, fontWeight: FontWeight.w500),
                        ),
                      ],
                    ),
                  ),
                ),
                if (_showAdvanced) ...[
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(child: _numField('Epochs', _epochsController, tooltip: kFieldTooltips['epochs'])),
                      const SizedBox(width: 12),
                      Expanded(child: _numField('Batch size', _batchSizeController, tooltip: kFieldTooltips['batchSize'])),
                      const SizedBox(width: 12),
                      Expanded(child: _numField('Learning rate', _learningRateController, tooltip: kFieldTooltips['learningRate'])),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'The dataset is split 70/15/15 into train/validation/test. The test split is never seen during training or tuning, so the accuracy you get back is a real held-out measurement.',
                    style: TextStyle(color: VidColors.neutral500, fontSize: 12, height: 1.5),
                  ),
                ],
                const SizedBox(height: 20),
                if (_formError != null) ...[
                  DangerAlert(message: _formError!),
                  const SizedBox(height: 12),
                ],
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: _submitting ? null : _submit,
                    icon: _submitting
                        ? SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2, color: VidColors.ink))
                        : const Icon(Icons.play_arrow),
                    label: Text(_submitting ? 'Starting…' : 'Start training'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _numField(String label, TextEditingController controller, {String? tooltip}) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        FieldLabel(label, tooltip: tooltip),
        TextField(
          controller: controller,
          enabled: !_submitting,
          keyboardType: TextInputType.number,
        ),
      ],
    );
  }

  Widget _buildActionRow(int index, ScannedAction action) {
    final thin = action.imagePaths.isNotEmpty && action.imagePaths.length < 3;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        decoration: BoxDecoration(
          color: VidColors.neutral100,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: thin ? VidColors.warning : VidColors.neutral200),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(action.name,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: VidColors.text, fontWeight: FontWeight.w500)),
                  const SizedBox(height: 2),
                  Text(
                    action.imagePaths.isEmpty
                        ? 'No images yet'
                        : '${action.imagePaths.length} image${action.imagePaths.length == 1 ? '' : 's'}'
                            '${thin ? ', needs at least 3' : ''}',
                    style: TextStyle(
                      color: thin ? VidColors.warning : VidColors.neutral500,
                      fontSize: 13,
                    ),
                  ),
                ],
              ),
            ),
            TextButton(onPressed: () => _addImagesTo(index), child: const Text('Add images…')),
            IconButton(
              tooltip: 'Rename',
              onPressed: () => _renameAction(index),
              icon: Icon(Icons.edit_outlined, size: 18, color: VidColors.neutral500),
            ),
            IconButton(
              tooltip: 'Remove',
              onPressed: () => setState(() => _actions.removeAt(index)),
              icon: Icon(Icons.close, size: 18, color: VidColors.neutral500),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildJobs() {
    if (_jobsError != null && _jobs == null) return DangerAlert(message: _jobsError!);
    if (_jobs == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 60),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (_jobs!.isEmpty) {
      return const EmptyStateWidget(
        title: 'No training runs yet',
        subtitle: 'Build a dataset on the Train tab to get started.',
      );
    }
    return Column(children: _jobs!.map(_buildJobCard).toList());
  }

  Widget _buildJobCard(TrainingJob job) {
    final progress = job.progress;
    final headline = job.metrics?.headline;

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
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(job.modelName,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: VidColors.text, fontWeight: FontWeight.w500)),
                      const SizedBox(height: 2),
                      Text(
                        '${job.actionCount} actions · ${job.imageCount} images · ${job.epochs} epochs',
                        style: TextStyle(color: VidColors.neutral500, fontSize: 13),
                      ),
                    ],
                  ),
                ),
                StatusBadge(status: job.status),
              ],
            ),
            if (job.status == JobStatus.processing && progress != null) ...[
              const SizedBox(height: 14),
              JobProgressPanel(label: progress.label, fraction: progress.overallFraction),
              if (progress.accuracy != null) ...[
                const SizedBox(height: 8),
                Text(
                  'train acc ${(progress.accuracy! * 100).toStringAsFixed(1)}%'
                  '${progress.valAccuracy != null ? ' · val acc ${(progress.valAccuracy! * 100).toStringAsFixed(1)}%' : ''}',
                  style: TextStyle(color: VidColors.neutral500, fontSize: 12, fontFamily: 'monospace'),
                ),
              ],
            ],
            if (job.status == JobStatus.queued) ...[
              const SizedBox(height: 12),
              Text(
                'Waiting for the local engine, training starts once any running job finishes.',
                style: TextStyle(color: VidColors.neutral500, fontSize: 13),
              ),
            ],
            if (job.status == JobStatus.done && headline != null) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  VidBadge(
                    label: 'test accuracy ${(headline.accuracy * 100).toStringAsFixed(1)}%',
                    tone: BadgeTone.success,
                  ),
                  const SizedBox(width: 8),
                  Text(
                    'on ${headline.testSetSize} held-out images',
                    style: TextStyle(color: VidColors.neutral500, fontSize: 12),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              OutlinedButton(
                onPressed: widget.onOpenModels,
                child: const Text('View in My detectors'),
              ),
            ],
            if (job.status == JobStatus.failed) ...[
              const SizedBox(height: 12),
              DangerAlert(message: job.error ?? 'Training failed.'),
              const SizedBox(height: 10),
              Row(
                children: [
                  Tooltip(
                    message: kButtonTooltips['retry']!,
                    child: OutlinedButton(onPressed: () => _retry(job), child: const Text('Retry')),
                  ),
                  const SizedBox(width: 8),
                  TextButton(onPressed: () => _deleteJob(job), child: const Text('Delete')),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }
}
