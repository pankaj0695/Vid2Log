/// Ported from frontend/app/create-actions/page.tsx, auto-discover action
/// classes from one demo video instead of hand-curating example images.
///
/// Structure mirrors the web page one-for-one:
///   * Two tabs when not reviewing, "Discover" (start a run + job history)
///     and "Saved datasets" (view / edit / delete).
///   * One shared review UI used for BOTH reviewing a just-finished
///     discovery run and editing an already-saved dataset, they're the same
///     interaction (name, merge, add, drop, save), so they're the same
///     screen rather than two near-duplicates.
///   * Review is a two-column layout: action cards on the left, a sticky
///     "Manage actions" + Save/Cancel panel on the right, so merging or
///     adding never requires scrolling back to the top.
///   * Images can be clicked to open full-size (with ← → to step through
///     that action's other images), removed individually, or DRAGGED from
///     one action card onto another to move them.
///
/// Every image here is a plain absolute path, a discovery preview frame, an
/// image already in a saved dataset, or one just picked off disk are all
/// the same kind of thing. That's what makes dragging between actions work
/// regardless of origin, and lets one save endpoint serve both modes (see
/// python_sidecar/app/main.py's SaveDatasetAction). They render straight
/// from disk with Image.file, no HTTP round trip per thumbnail, since this
/// is a desktop app reading its own machine.
library;

import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../models/job.dart';
import '../models/training.dart';
import '../services/api_client.dart';
import '../widgets/image_lightbox.dart';
import '../widgets/progress.dart';
import '../widgets/ui.dart';

enum _Tab { discover, saved }

/// Whether the review UI is looking at a fresh discovery run or an existing
/// saved dataset, the only thing that differs is where Save writes to.
enum _ReviewMode { discover, edit }

int _idCounter = 0;

/// `Iterable.firstOrNull` lives in package:collection, which this app
/// doesn't depend on, one tiny helper is cheaper than a dependency.
T? _firstWhereOrNull<T>(Iterable<T> items, bool Function(T) test) {
  for (final item in items) {
    if (test(item)) return item;
  }
  return null;
}

/// One action being reviewed. Identity is a synthetic id, not the name, so
/// renaming an action doesn't break a drag in flight or the merge selection.
class _ActionDraft {
  _ActionDraft({required this.name, required this.images})
      : id = 'action-${_idCounter++}',
        nameController = TextEditingController(text: name);

  final String id;
  String name;
  final TextEditingController nameController;

  /// Absolute image paths.
  List<String> images;

  /// How many images are still being fetched, so the grid can show that
  /// many placeholders instead of misreporting "no images yet".
  int pending = 0;

  void dispose() => nameController.dispose();
}

class CreateActionsScreen extends StatefulWidget {
  const CreateActionsScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<CreateActionsScreen> createState() => _CreateActionsScreenState();
}

class _CreateActionsScreenState extends State<CreateActionsScreen> {
  _Tab _tab = _Tab.discover;

  // ── Discover form ──
  String? _videoPath;
  String? _videoName;
  final _fpsController = TextEditingController(text: '2');
  final _minClusterController = TextEditingController(text: '5');
  bool _starting = false;
  String? _discoverError;

  // ── Discovery jobs ──
  List<DiscoveryJob>? _jobs;
  Timer? _pollTimer;

  /// The run started from this screen, its review opens automatically the
  /// moment it finishes, rather than making the user come back and click.
  String? _autoOpenJobId;

  // ── Review / edit ──
  _ReviewMode? _reviewMode;
  String? _reviewSourceId;
  String _reviewSourceLabel = '';
  List<_ActionDraft> _drafts = [];
  final Set<String> _selectedForMerge = {};
  final _datasetNameController = TextEditingController();
  bool _saving = false;
  String? _saveError;
  String? _dragOverActionId;

  // ── Saved datasets ──
  List<ActionDataset>? _datasets;
  String? _expandedDatasetId;
  Map<String, List<String>>? _expandedActions;

  @override
  void initState() {
    super.initState();
    _loadJobs();
    _loadDatasets();
    _pollTimer = Timer.periodic(const Duration(seconds: 3), (_) {
      final hasActive = _jobs?.any(
            (j) => j.status == JobStatus.queued || j.status == JobStatus.processing,
          ) ??
          false;
      if (hasActive || _autoOpenJobId != null) _loadJobs();
    });
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _fpsController.dispose();
    _minClusterController.dispose();
    _datasetNameController.dispose();
    for (final d in _drafts) {
      d.dispose();
    }
    super.dispose();
  }

  Future<void> _loadJobs() async {
    try {
      final jobs = await widget.apiClient.listDiscoveryJobs();
      if (!mounted) return;
      setState(() => _jobs = jobs);

      // Auto-open the run this screen started, once it lands.
      final target = _autoOpenJobId;
      if (target != null && _reviewMode == null) {
        final job = _firstWhereOrNull(jobs, (j) => j.discoveryJobId == target);
        if (job != null && job.status == JobStatus.done) {
          _autoOpenJobId = null;
          await _openReview(job);
        } else if (job != null && job.status == JobStatus.failed) {
          _autoOpenJobId = null;
        }
      }
    } catch (_) {
      // Transient, the next tick retries, and the form stays usable.
    }
  }

  Future<void> _loadDatasets() async {
    try {
      final datasets = await widget.apiClient.listActionDatasets();
      if (!mounted) return;
      setState(() => _datasets = datasets);
    } catch (_) {
      if (!mounted) return;
      setState(() => _datasets = const []);
    }
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  Future<void> _pickVideo() async {
    final result = await FilePicker.platform.pickFiles(type: FileType.video);
    final path = result?.files.single.path;
    if (path == null) return;
    setState(() {
      _videoPath = path;
      _videoName = result!.files.single.name;
    });
  }

  Future<void> _startDiscovery() async {
    if (_videoPath == null) {
      setState(() => _discoverError = 'Choose a video file first.');
      return;
    }
    setState(() {
      _starting = true;
      _discoverError = null;
    });
    try {
      final job = await widget.apiClient.startDiscovery(
        videoPath: _videoPath!,
        fps: int.tryParse(_fpsController.text.trim()) ?? 2,
        minClusterSize: int.tryParse(_minClusterController.text.trim()) ?? 5,
      );
      if (!mounted) return;
      setState(() {
        _videoPath = null;
        _videoName = null;
        _autoOpenJobId = job.discoveryJobId;
      });
      await _loadJobs();
    } catch (e) {
      if (!mounted) return;
      setState(() => _discoverError = '$e');
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  Future<void> _deleteJob(DiscoveryJob job) async {
    try {
      await widget.apiClient.deleteDiscoveryJob(job.discoveryJobId);
      if (_autoOpenJobId == job.discoveryJobId) _autoOpenJobId = null;
      await _loadJobs();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  // ── Review / edit ──────────────────────────────────────────────────────

  Future<void> _openReview(DiscoveryJob job) async {
    final clusters = job.clusters ?? const <DiscoveredCluster>[];
    // Cards render immediately with placeholders; each cluster's frames fill
    // in as its own request resolves, rather than the whole screen waiting
    // on the slowest one.
    final drafts = [
      for (final c in clusters)
        _ActionDraft(name: c.name, images: [])..pending = c.frameCount,
    ];
    setState(() {
      _reviewMode = _ReviewMode.discover;
      _reviewSourceId = job.discoveryJobId;
      _reviewSourceLabel = job.originalFilename;
      _drafts = drafts;
      _selectedForMerge.clear();
      _saveError = null;
      _datasetNameController.text = job.originalFilename.replaceAll(RegExp(r'\.[^.]+$'), '');
    });

    await Future.wait([
      for (var i = 0; i < clusters.length; i++)
        widget.apiClient.listClusterFrames(job.discoveryJobId, clusters[i].id).then((frames) {
          if (!mounted) return;
          setState(() {
            drafts[i].images = frames;
            drafts[i].pending = 0;
          });
        }).catchError((_) {
          if (!mounted) return;
          setState(() => drafts[i].pending = 0);
        }),
    ]);
  }

  Future<void> _openEditDataset(ActionDataset dataset) async {
    setState(() {
      _reviewMode = _ReviewMode.edit;
      _reviewSourceId = dataset.datasetId;
      _reviewSourceLabel = dataset.name;
      _drafts = [
        for (final e in dataset.actionCounts.entries)
          _ActionDraft(name: e.key, images: [])..pending = e.value,
      ];
      _selectedForMerge.clear();
      _saveError = null;
      _datasetNameController.text = dataset.name;
    });

    try {
      final detail = await widget.apiClient.getActionDataset(dataset.datasetId);
      if (!mounted) return;
      setState(() {
        for (final d in _drafts) {
          d.dispose();
        }
        _drafts = [
          for (final e in detail.actions.entries) _ActionDraft(name: e.key, images: e.value),
        ];
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _saveError = '$e';
        for (final d in _drafts) {
          d.pending = 0;
        }
      });
    }
  }

  void _exitReview() {
    for (final d in _drafts) {
      d.dispose();
    }
    setState(() {
      _reviewMode = null;
      _reviewSourceId = null;
      _reviewSourceLabel = '';
      _drafts = [];
      _selectedForMerge.clear();
      _saveError = null;
      _datasetNameController.clear();
    });
  }

  void _addAction() {
    setState(() => _drafts.add(_ActionDraft(name: 'Action ${_drafts.length + 1}', images: [])));
  }

  void _removeAction(_ActionDraft draft) {
    setState(() {
      _drafts.remove(draft);
      _selectedForMerge.remove(draft.id);
    });
    draft.dispose();
  }

  /// Folds every selected action into the first one, in selection order,
  /// the merged action keeps that first action's name.
  void _mergeSelected() {
    if (_selectedForMerge.length < 2) return;
    setState(() {
      _ActionDraft? into;
      final survivors = <_ActionDraft>[];
      final absorbed = <_ActionDraft>[];
      for (final d in _drafts) {
        if (_selectedForMerge.contains(d.id)) {
          if (into == null) {
            into = d;
            survivors.add(d);
          } else {
            into.images = [...into.images, ...d.images];
            absorbed.add(d);
          }
        } else {
          survivors.add(d);
        }
      }
      _drafts = survivors;
      _selectedForMerge.clear();
      for (final d in absorbed) {
        d.dispose();
      }
    });
  }

  Future<void> _addImagesTo(_ActionDraft draft) async {
    final result = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      type: FileType.image,
      dialogTitle: 'Add images to "${draft.name}"',
    );
    if (result == null) return;
    final picked = result.files.map((f) => f.path).whereType<String>();
    setState(() {
      // Union, preserving order, re-picking a file the action already has
      // shouldn't duplicate it.
      draft.images = [...draft.images, ...picked.where((p) => !draft.images.contains(p))];
    });
  }

  /// Moves one image between actions. No-op when dropped back on its own
  /// action, and a plain list move, nothing is copied or re-read.
  void _moveImage(String imagePath, String fromActionId, String toActionId) {
    if (fromActionId == toActionId) return;
    setState(() {
      final from = _firstWhereOrNull(_drafts, (d) => d.id == fromActionId);
      final to = _firstWhereOrNull(_drafts, (d) => d.id == toActionId);
      if (from == null || to == null || !from.images.contains(imagePath)) return;
      from.images = [...from.images]..remove(imagePath);
      to.images = [...to.images, imagePath];
    });
  }

  Future<void> _save() async {
    setState(() => _saveError = null);

    final name = _datasetNameController.text.trim();
    if (name.isEmpty) {
      setState(() => _saveError = 'Give this dataset a name.');
      return;
    }

    for (final d in _drafts) {
      d.name = d.nameController.text.trim();
    }
    final usable = _drafts.where((d) => d.name.isNotEmpty && d.images.isNotEmpty).toList();
    if (usable.length < 2) {
      setState(() => _saveError =
          'Keep at least 2 actions with images, a model needs 2 classes to tell apart.');
      return;
    }
    final names = usable.map((d) => d.name).toList();
    if (names.toSet().length != names.length) {
      setState(() => _saveError = 'Two actions have the same name, merge them or rename one.');
      return;
    }

    setState(() => _saving = true);
    try {
      final actions = {for (final d in usable) d.name: d.images};
      if (_reviewMode == _ReviewMode.edit) {
        await widget.apiClient.updateActionDataset(
          datasetId: _reviewSourceId!,
          name: name,
          actions: actions,
        );
      } else {
        await widget.apiClient.createActionDataset(
          name: name,
          actions: actions,
          discoveryJobId: _reviewSourceId,
        );
      }
      if (!mounted) return;
      _exitReview();
      setState(() {
        _tab = _Tab.saved;
        // Any expanded preview now points at replaced files.
        _expandedDatasetId = null;
        _expandedActions = null;
      });
      await _loadJobs();
      await _loadDatasets();
    } catch (e) {
      if (!mounted) return;
      setState(() => _saveError = '$e');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // ── Saved datasets ─────────────────────────────────────────────────────

  Future<void> _toggleExpand(ActionDataset dataset) async {
    if (_expandedDatasetId == dataset.datasetId) {
      setState(() {
        _expandedDatasetId = null;
        _expandedActions = null;
      });
      return;
    }
    setState(() {
      _expandedDatasetId = dataset.datasetId;
      _expandedActions = null;
    });
    try {
      final detail = await widget.apiClient.getActionDataset(dataset.datasetId);
      if (!mounted || _expandedDatasetId != dataset.datasetId) return;
      setState(() => _expandedActions = detail.actions);
    } catch (_) {
      // Thumbnails are a nicety, the name/counts above still render.
    }
  }

  Future<void> _deleteDataset(ActionDataset dataset) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this dataset?'),
        content: Text(
          'This permanently deletes "${dataset.name}" and all ${dataset.imageCount} of its images. '
          'Models already trained from it are unaffected. This can\'t be undone.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(
                backgroundColor: VidColors.danger, foregroundColor: Colors.white),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete dataset'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await widget.apiClient.deleteActionDataset(dataset.datasetId);
      if (_expandedDatasetId == dataset.datasetId) {
        _expandedDatasetId = null;
        _expandedActions = null;
      }
      await _loadDatasets();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  // ── Build ──────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    final activeCount = _jobs
            ?.where((j) => j.status == JobStatus.queued || j.status == JobStatus.processing)
            .length ??
        0;

    return Stack(
      children: [
        // Review mode gets its own layout (see _buildReview) so the
        // "Manage actions" panel can stay fixed on screen instead of
        // living inside the same scroll view as the action list. Every
        // other tab keeps the simple single-scroll-view layout.
        if (_reviewMode != null)
          _buildReview()
        else
          SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const PageHeader(
                  eyebrow: 'Create actions',
                  title: 'Auto-discover actions from a video',
                ),
                VidTabs<_Tab>(
                  tabs: [
                    (_Tab.discover, 'Discover${activeCount > 0 ? ' ($activeCount active)' : ''}'),
                    (_Tab.saved, 'Saved datasets'),
                  ],
                  active: _tab,
                  onChange: (t) => setState(() => _tab = t),
                ),
                if (_tab == _Tab.discover) _buildDiscoverTab() else _buildSavedTab(),
              ],
            ),
          ),
        if (_saving) _buildSavingOverlay(),
      ],
    );
  }

  Widget _buildSavingOverlay() {
    return Positioned.fill(
      child: ColoredBox(
        color: Colors.black54,
        child: Center(
          child: VidCard(
            padding: const EdgeInsets.symmetric(horizontal: 36, vertical: 28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const CircularProgressIndicator(),
                const SizedBox(height: 16),
                Text('Saving your dataset…',
                    style: TextStyle(color: VidColors.text, fontWeight: FontWeight.w600)),
                const SizedBox(height: 14),
                const SizedBox(width: 220, child: VidProgressBar()),
              ],
            ),
          ),
        ),
      ),
    );
  }

  // ── Discover tab ──

  Widget _buildDiscoverTab() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 760),
          child: VidCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const VidCardHeader(title: 'Choose a demo video'),
                Text(
                  'It samples frames, groups visually similar screens together, and proposes each '
                  'group as a candidate action for you to name and adjust.',
                  style: TextStyle(color: VidColors.neutral500, fontSize: 13, height: 1.5),
                ),
                const SizedBox(height: 16),
                InkWell(
                  onTap: _starting ? null : _pickVideo,
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
                            _videoName ?? 'Choose a screen recording…',
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
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(child: _numField('Sampling FPS', _fpsController)),
                    const SizedBox(width: 12),
                    Expanded(child: _numField('Minimum cluster size', _minClusterController)),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  'Min cluster size is the fewest frames a screen must appear in to count as its own '
                  'action. Lower it if distinct screens get lumped together; raise it if you get lots '
                  'of near-duplicate actions.',
                  style: TextStyle(color: VidColors.neutral500, fontSize: 12, height: 1.5),
                ),
                const SizedBox(height: 20),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: (_videoPath == null || _starting) ? null : _startDiscovery,
                    icon: _starting
                        ? SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2, color: VidColors.ink))
                        : const Icon(Icons.auto_awesome_outlined),
                    label: Text(_starting ? 'Starting…' : 'Discover actions'),
                  ),
                ),
                if (_discoverError != null) ...[
                  const SizedBox(height: 12),
                  DangerAlert(message: _discoverError!),
                ],
              ],
            ),
          ),
        ),
        const SizedBox(height: 24),
        Text('Discovery jobs',
            style: TextStyle(color: VidColors.text, fontSize: 17, fontWeight: FontWeight.w600)),
        const SizedBox(height: 12),
        if (_jobs == null)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 40),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (_jobs!.isEmpty)
          const EmptyStateWidget(title: 'No discovery jobs yet')
        else
          ..._jobs!.map(_buildJobCard),
      ],
    );
  }

  Widget _numField(String label, TextEditingController controller) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: TextStyle(
                color: VidColors.neutral500, fontSize: 13, fontWeight: FontWeight.w500)),
        const SizedBox(height: 6),
        TextField(controller: controller, enabled: !_starting, keyboardType: TextInputType.number),
      ],
    );
  }

  Widget _buildJobCard(DiscoveryJob job) {
    final progress = job.progress;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
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
                        Text(job.originalFilename,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                                color: VidColors.text, fontWeight: FontWeight.w500)),
                        const SizedBox(height: 2),
                        Text(
                          job.clusters != null
                              ? '${job.clusters!.length} actions found'
                              : '${job.fps} fps · min cluster ${job.minClusterSize}',
                          style: TextStyle(color: VidColors.neutral500, fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                  StatusBadge(status: job.status),
                  if (job.status == JobStatus.done) ...[
                    const SizedBox(width: 8),
                    FilledButton(
                        onPressed: () => _openReview(job), child: const Text('Review')),
                  ],
                  if (job.status != JobStatus.processing) ...[
                    const SizedBox(width: 4),
                    IconButton(
                      tooltip: job.status == JobStatus.queued ? 'Cancel' : 'Delete',
                      onPressed: () => _deleteJob(job),
                      icon: Icon(Icons.close, size: 18, color: VidColors.neutral500),
                    ),
                  ],
                ],
              ),
              if (job.status == JobStatus.processing) ...[
                const SizedBox(height: 12),
                JobProgressPanel(
                  label: progress?.label ?? 'Working…',
                  fraction: progress?.overallFraction,
                ),
                if (_autoOpenJobId == job.discoveryJobId) ...[
                  const SizedBox(height: 8),
                  Text('Opens for review automatically when done',
                      style: TextStyle(color: VidColors.neutral400, fontSize: 12)),
                ],
              ],
              if (job.status == JobStatus.failed && job.error != null) ...[
                const SizedBox(height: 12),
                DangerAlert(message: job.error!),
              ],
            ],
          ),
        ),
      ),
    );
  }

  // ── Review / edit ──

  /// Two-column review layout: the page header + action list scroll on the
  /// left; the "Manage actions" + Save/Cancel panel is pinned OUTSIDE that
  /// scroll view in the top-right corner (with a top margin), so it stays
  /// on screen and reachable no matter how far the list is scrolled.
  Widget _buildReview() {
    return LayoutBuilder(builder: (context, constraints) {
      final wide = constraints.maxWidth > 900;
      final panel = _buildManagePanel();

      if (!wide) {
        // Narrow window: no room for a fixed side column, so fall back to
        // everything in one scroll view with the panel up top.
        return SingleChildScrollView(
          padding: const EdgeInsets.all(28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const PageHeader(
                eyebrow: 'Create actions',
                title: 'Auto-discover actions from a video',
              ),
              panel,
              const SizedBox(height: 16),
              _buildReviewList(),
            ],
          ),
        );
      }

      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(28, 28, 28, 0),
            child: PageHeader(
              eyebrow: 'Create actions',
              title: 'Auto-discover actions from a video',
            ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(28, 0, 28, 28),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: SingleChildScrollView(child: _buildReviewList()),
                  ),
                  const SizedBox(width: 20),
                  SizedBox(
                    width: 260,
                    // The top margin that keeps the panel from sitting
                    // flush against the header above it.
                    child: Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: panel,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      );
    });
  }

  Widget _buildReviewList() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            TextButton.icon(
              onPressed: _saving ? null : _exitReview,
              icon: const Icon(Icons.chevron_left, size: 18),
              label: const Text('Back'),
            ),
            const SizedBox(width: 4),
            Flexible(
              child: Text(
                '${_reviewMode == _ReviewMode.discover ? "Reviewing actions from" : "Editing"} $_reviewSourceLabel',
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: VidColors.neutral500, fontSize: 13),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        VidCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const VidCardHeader(title: 'Dataset name'),
              TextField(
                controller: _datasetNameController,
                enabled: !_saving,
                decoration: const InputDecoration(hintText: 'e.g. checkout-flow-actions'),
              ),
            ],
          ),
        ),
        if (_saveError != null) ...[
          const SizedBox(height: 12),
          DangerAlert(message: _saveError!),
        ],
        const SizedBox(height: 12),
        if (_drafts.isEmpty)
          const EmptyStateWidget(title: 'No actions to review')
        else
          ..._drafts.map(_buildActionCard),
      ],
    );
  }

  Widget _buildActionCard(_ActionDraft draft) {
    final isDropTarget = _dragOverActionId == draft.id;

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: DragTarget<_DragPayload>(
        onWillAcceptWithDetails: (details) {
          final accept = details.data.actionId != draft.id;
          if (accept && _dragOverActionId != draft.id) {
            // Deferred: onWillAccept fires during a build/layout pass, and
            // calling setState synchronously from inside it throws.
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) setState(() => _dragOverActionId = draft.id);
            });
          }
          return accept;
        },
        onLeave: (_) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted && _dragOverActionId == draft.id) {
              setState(() => _dragOverActionId = null);
            }
          });
        },
        onAcceptWithDetails: (details) {
          _moveImage(details.data.imagePath, details.data.actionId, draft.id);
          setState(() => _dragOverActionId = null);
        },
        builder: (context, candidate, rejected) {
          return Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: isDropTarget ? VidColors.primary : Colors.transparent,
                width: 2,
              ),
            ),
            child: VidCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Checkbox(
                        value: _selectedForMerge.contains(draft.id),
                        onChanged: _saving
                            ? null
                            : (v) => setState(() {
                                  if (v == true) {
                                    _selectedForMerge.add(draft.id);
                                  } else {
                                    _selectedForMerge.remove(draft.id);
                                  }
                                }),
                      ),
                      SizedBox(
                        width: 220,
                        child: TextField(
                          controller: draft.nameController,
                          enabled: !_saving,
                          onChanged: (v) => draft.name = v,
                          decoration: const InputDecoration(isDense: true),
                        ),
                      ),
                      const SizedBox(width: 10),
                      VidBadge(
                        label:
                            '${draft.images.length} image${draft.images.length == 1 ? '' : 's'}',
                        tone: BadgeTone.neutral,
                      ),
                      const Spacer(),
                      OutlinedButton(
                        onPressed: _saving ? null : () => _addImagesTo(draft),
                        child: const Text('+ Add images'),
                      ),
                      const SizedBox(width: 8),
                      OutlinedButton(
                        style: OutlinedButton.styleFrom(
                          foregroundColor: VidColors.danger,
                          side: BorderSide(color: VidColors.danger),
                        ),
                        onPressed: _saving ? null : () => _removeAction(draft),
                        child: const Text('Delete'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 14),
                  if (draft.images.isEmpty && draft.pending == 0)
                    Text(
                      isDropTarget
                          ? 'Drop to move the image here'
                          : 'No images in this action yet.',
                      style: TextStyle(color: VidColors.neutral500, fontSize: 13),
                    )
                  else
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final path in draft.images)
                          _DraggableThumb(
                            imagePath: path,
                            actionId: draft.id,
                            enabled: !_saving,
                            onOpen: () => showImageLightbox(
                              context,
                              imagePaths: draft.images,
                              initialIndex: draft.images.indexOf(path),
                            ),
                            onRemove: () =>
                                setState(() => draft.images = [...draft.images]..remove(path)),
                          ),
                        for (var i = 0; i < draft.pending; i++)
                          Container(
                            width: 96,
                            height: 96,
                            decoration: BoxDecoration(
                              color: VidColors.neutral100,
                              borderRadius: BorderRadius.circular(8),
                            ),
                          ),
                      ],
                    ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  /// The "Manage actions" + Save/Cancel panel, pinned OUTSIDE the action
  /// list's scroll view by [_buildReview] so it stays fixed on screen
  /// (merge/add/save always reachable) instead of scrolling away with the
  /// list, matching the intent of the web layout's sticky sidebar.
  Widget _buildManagePanel() {
    final mergeCount = _selectedForMerge.length;
    return Column(
      children: [
        VidCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text('Manage actions',
                    style: TextStyle(
                        color: VidColors.text, fontWeight: FontWeight.w600, fontSize: 14)),
              ),
              OutlinedButton(
                onPressed: _saving ? null : _addAction,
                child: const Text('+ Add new action'),
              ),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: (mergeCount < 2 || _saving) ? null : _mergeSelected,
                child: Text('Merge selected${mergeCount > 1 ? ' ($mergeCount)' : ''}'),
              ),
              const SizedBox(height: 10),
              Text(
                'Tick two or more actions to merge them, or drag an image from one action onto another to move it.',
                style: TextStyle(color: VidColors.neutral500, fontSize: 12, height: 1.4),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        VidCard(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              FilledButton(
                onPressed: (_saving || _drafts.isEmpty) ? null : _save,
                child: Text(_reviewMode == _ReviewMode.edit ? 'Save changes' : 'Save dataset'),
              ),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: _saving ? null : _exitReview,
                child: const Text('Cancel'),
              ),
            ],
          ),
        ),
      ],
    );
  }

  // ── Saved datasets tab ──

  Widget _buildSavedTab() {
    final datasets = _datasets;
    if (datasets == null) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 60),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (datasets.isEmpty) {
      return const EmptyStateWidget(
        title: 'No saved datasets yet',
        subtitle: 'Discover actions from a video on the Discover tab, review them, and save.',
      );
    }
    return Column(children: datasets.map(_buildDatasetCard).toList());
  }

  Widget _buildDatasetCard(ActionDataset dataset) {
    final expanded = _expandedDatasetId == dataset.datasetId;
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
                      Text(dataset.name,
                          overflow: TextOverflow.ellipsis,
                          style:
                              TextStyle(color: VidColors.text, fontWeight: FontWeight.w600)),
                      const SizedBox(height: 2),
                      Text(
                        '${dataset.actionCounts.length} action${dataset.actionCounts.length == 1 ? '' : 's'} · ${dataset.imageCount} images',
                        style: TextStyle(color: VidColors.neutral500, fontSize: 13),
                      ),
                    ],
                  ),
                ),
                OutlinedButton(
                  onPressed: () => _toggleExpand(dataset),
                  child: Text(expanded ? 'Hide' : 'View'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: () => _openEditDataset(dataset),
                  child: const Text('Edit'),
                ),
                const SizedBox(width: 8),
                OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: VidColors.danger,
                    side: BorderSide(color: VidColors.danger),
                  ),
                  onPressed: () => _deleteDataset(dataset),
                  child: const Text('Delete'),
                ),
              ],
            ),
            if (expanded) ...[
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 14),
                child: Divider(height: 1, color: VidColors.neutral200),
              ),
              if (_expandedActions == null)
                const Center(child: Padding(
                  padding: EdgeInsets.symmetric(vertical: 20),
                  child: CircularProgressIndicator(),
                ))
              else
                ..._expandedActions!.entries.map((e) => Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('${e.key}  (${e.value.length})',
                              style: TextStyle(
                                  color: VidColors.text, fontWeight: FontWeight.w500, fontSize: 13)),
                          const SizedBox(height: 8),
                          Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              for (var i = 0; i < e.value.length && i < 12; i++)
                                _Thumb(
                                  imagePath: e.value[i],
                                  onTap: () => showImageLightbox(
                                    context,
                                    imagePaths: e.value,
                                    initialIndex: i,
                                  ),
                                ),
                              if (e.value.length > 12)
                                Container(
                                  width: 96,
                                  height: 96,
                                  alignment: Alignment.center,
                                  decoration: BoxDecoration(
                                    color: VidColors.neutral100,
                                    borderRadius: BorderRadius.circular(8),
                                  ),
                                  child: Text('+${e.value.length - 12}',
                                      style: TextStyle(
                                          color: VidColors.neutral500, fontSize: 13)),
                                ),
                            ],
                          ),
                        ],
                      ),
                    )),
            ],
          ],
        ),
      ),
    );
  }
}

/// What travels with a dragged thumbnail, which image, and which action
/// it's leaving, so the receiving card knows what to move and from where.
class _DragPayload {
  const _DragPayload({required this.imagePath, required this.actionId});
  final String imagePath;
  final String actionId;
}

/// A thumbnail in the review grid: click to open full-size, hover-free ×
/// to remove, and draggable onto another action card to move it.
class _DraggableThumb extends StatelessWidget {
  const _DraggableThumb({
    required this.imagePath,
    required this.actionId,
    required this.enabled,
    required this.onOpen,
    required this.onRemove,
  });

  final String imagePath;
  final String actionId;
  final bool enabled;
  final VoidCallback onOpen;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final tile = Stack(
      children: [
        _Thumb(imagePath: imagePath, onTap: onOpen),
        Positioned(
          top: 3,
          right: 3,
          child: InkWell(
            onTap: enabled ? onRemove : null,
            child: Container(
              padding: const EdgeInsets.all(2),
              decoration: const BoxDecoration(color: Colors.black87, shape: BoxShape.circle),
              child: const Icon(Icons.close, size: 13, color: Colors.white),
            ),
          ),
        ),
      ],
    );

    if (!enabled) return tile;

    return Draggable<_DragPayload>(
      data: _DragPayload(imagePath: imagePath, actionId: actionId),
      dragAnchorStrategy: pointerDragAnchorStrategy,
      feedback: Opacity(
        opacity: 0.85,
        child: _Thumb(imagePath: imagePath, onTap: null),
      ),
      childWhenDragging: Opacity(opacity: 0.35, child: tile),
      child: MouseRegion(cursor: SystemMouseCursors.grab, child: tile),
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.imagePath, required this.onTap});

  final String imagePath;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final image = ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: Image.file(
        File(imagePath),
        width: 96,
        height: 96,
        fit: BoxFit.cover,
        // Decoding at display size instead of full resolution keeps a grid
        // of dozens of 1080p screenshots from ballooning memory.
        cacheWidth: 192,
        errorBuilder: (_, __, ___) => Container(
          width: 96,
          height: 96,
          color: VidColors.neutral100,
          alignment: Alignment.center,
          child: Icon(Icons.broken_image_outlined, size: 18, color: VidColors.neutral400),
        ),
      ),
    );

    if (onTap == null) return image;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(onTap: onTap, child: image),
    );
  }
}
