/// Ported from frontend/app/models/page.tsx + models/[id]/page.tsx, the
/// local Model Registry: every locally-trained model plus the bundled
/// default, with activate/rename/delete and the full metrics report
/// (CNN-only vs text-only vs fused, per-action precision/recall/F1, and the
/// confusion matrix) that Teachable Machine never exposed.
library;

import 'package:flutter/material.dart';

import '../models/training.dart';
import '../services/api_client.dart';
import '../widgets/ui.dart';

class ModelsScreen extends StatefulWidget {
  const ModelsScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<ModelsScreen> createState() => _ModelsScreenState();
}

class _ModelsScreenState extends State<ModelsScreen> {
  List<ModelInfo>? _models;
  String? _error;
  String? _busyId;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final models = await widget.apiClient.listModels();
      if (!mounted) return;
      setState(() {
        _models = models;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '$e');
    }
  }

  Future<void> _activate(ModelInfo model) async {
    setState(() => _busyId = model.modelId);
    try {
      await widget.apiClient.activateModel(model.modelId);
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    } finally {
      if (mounted) setState(() => _busyId = null);
    }
  }

  Future<void> _rename(ModelInfo model) async {
    final controller = TextEditingController(text: model.name);
    final name = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename model'),
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
    try {
      await widget.apiClient.renameModel(model.modelId, trimmed);
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  Future<void> _delete(ModelInfo model) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this model?'),
        content: Text(
          'This permanently deletes "${model.name}" and its weights from disk. '
          'Logs already produced with it are unaffected. This can\'t be undone.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: VidColors.danger, foregroundColor: Colors.white),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete model'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await widget.apiClient.deleteModel(model.modelId);
      await _load();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('$e')));
    }
  }

  void _openDetail(ModelInfo model) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => ModelDetailScreen(model: model)),
    );
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PageHeader(
            eyebrow: 'Models',
            title: 'Models',
            action: IconButton(
              tooltip: 'Refresh',
              onPressed: _load,
              icon: Icon(Icons.refresh_rounded, color: VidColors.neutral500),
            ),
          ),
          if (_error != null) ...[DangerAlert(message: _error!), const SizedBox(height: 16)],
          if (_models == null)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 60),
              child: Center(child: CircularProgressIndicator()),
            )
          else
            ..._models!.map(_buildModelCard),
        ],
      ),
    );
  }

  Widget _buildModelCard(ModelInfo model) {
    final headline = model.metrics?.headline;
    final busy = _busyId == model.modelId;

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: VidCard(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    color: model.isActive ? VidColors.primaryTint : VidColors.neutral100,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Icon(
                    Icons.inventory_2_outlined,
                    color: model.isActive ? VidColors.primaryHover : VidColors.neutral500,
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              model.name,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: VidColors.text,
                                fontWeight: FontWeight.w600,
                                fontSize: 15,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          if (model.isActive) const VidBadge(label: 'active', tone: BadgeTone.success),
                          if (model.isBundled) ...[
                            const SizedBox(width: 6),
                            const VidBadge(label: 'bundled', tone: BadgeTone.neutral),
                          ],
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        '${model.labels.length} action${model.labels.length == 1 ? '' : 's'}'
                        '${headline != null ? ' · test accuracy ${(headline.accuracy * 100).toStringAsFixed(1)}%' : ''}',
                        style: TextStyle(color: VidColors.neutral500, fontSize: 13),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 14),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                if (!model.isActive)
                  OutlinedButton(
                    onPressed: busy ? null : () => _activate(model),
                    child: Text(busy ? 'Activating…' : 'Activate'),
                  ),
                if (model.metrics != null)
                  TextButton(onPressed: () => _openDetail(model), child: const Text('View details')),
                if (!model.isBundled) ...[
                  OutlinedButton(onPressed: () => _rename(model), child: const Text('Rename')),
                  OutlinedButton(
                    style: OutlinedButton.styleFrom(
                      foregroundColor: VidColors.danger,
                      side: BorderSide(color: VidColors.danger),
                    ),
                    onPressed: () => _delete(model),
                    child: const Text('Delete'),
                  ),
                ],
              ],
            ),
            if (model.isBundled) ...[
              const SizedBox(height: 10),
              Text(
                'Ships inside the app and is used whenever no trained model is active. It can\'t be renamed or deleted.',
                style: TextStyle(color: VidColors.neutral500, fontSize: 12, height: 1.5),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// Full metrics report for one model, the three-way comparison the cloud
/// backend produces (see backend/app/services/training_pipeline.py's
/// docstring for why all three are reported, not just the best one).
class ModelDetailScreen extends StatelessWidget {
  const ModelDetailScreen({super.key, required this.model});

  final ModelInfo model;

  @override
  Widget build(BuildContext context) {
    final metrics = model.metrics;
    return Scaffold(
      backgroundColor: VidColors.bg,
      appBar: AppBar(title: Text(model.name)),
      body: metrics == null
          ? const EmptyStateWidget(title: 'No metrics for this model')
          : SingleChildScrollView(
              padding: const EdgeInsets.all(28),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildSummary(metrics),
                  const SizedBox(height: 20),
                  if (metrics.cnnOnly != null)
                    _ReportCard(title: 'CNN only', report: metrics.cnnOnly!, labels: model.labels),
                  if (metrics.textOnly != null) ...[
                    const SizedBox(height: 16),
                    _ReportCard(title: 'OCR text only', report: metrics.textOnly!, labels: model.labels),
                  ],
                  if (metrics.combined != null) ...[
                    const SizedBox(height: 16),
                    _ReportCard(
                      title: 'Combined (what actually runs)',
                      report: metrics.combined!,
                      labels: model.labels,
                    ),
                  ],
                  if (metrics.textOnly == null) ...[
                    const SizedBox(height: 16),
                    VidCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text('No OCR text fusion',
                              style: TextStyle(color: VidColors.text, fontWeight: FontWeight.w600)),
                          const SizedBox(height: 6),
                          Text(
                            'There wasn\'t enough readable on-screen text across the training '
                            'images to train a text classifier, so this model classifies on '
                            'pixels alone. That\'s expected for screens with little or no text, '
                            'the CNN result stands on its own.',
                            style: TextStyle(color: VidColors.neutral500, fontSize: 13, height: 1.5),
                          ),
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            ),
    );
  }

  Widget _buildSummary(ModelMetrics metrics) {
    final alpha = metrics.fusionAlpha;
    return VidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const VidCardHeader(title: 'Summary'),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              if (metrics.cnnOnly != null)
                _MiniStat(label: 'CNN only', value: '${(metrics.cnnOnly!.accuracy * 100).toStringAsFixed(1)}%'),
              if (metrics.textOnly != null)
                _MiniStat(label: 'Text only', value: '${(metrics.textOnly!.accuracy * 100).toStringAsFixed(1)}%'),
              if (metrics.combined != null)
                _MiniStat(label: 'Combined', value: '${(metrics.combined!.accuracy * 100).toStringAsFixed(1)}%'),
              if (alpha != null) _MiniStat(label: 'Fusion α', value: alpha.toStringAsFixed(1)),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            'Measured on ${metrics.headline?.testSetSize ?? 0} held-out test images the model '
            'never saw during training or tuning.'
            '${alpha != null ? ' α weights the CNN against the OCR text classifier, 1.0 means CNN only.' : ''}',
            style: TextStyle(color: VidColors.neutral500, fontSize: 13, height: 1.5),
          ),
        ],
      ),
    );
  }
}

class _MiniStat extends StatelessWidget {
  const _MiniStat({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: VidColors.neutral100,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: VidColors.neutral200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: TextStyle(color: VidColors.neutral500, fontSize: 12)),
          const SizedBox(height: 4),
          Text(
            value,
            style: TextStyle(
              color: VidColors.text,
              fontSize: 20,
              fontWeight: FontWeight.w600,
              fontFamily: 'monospace',
            ),
          ),
        ],
      ),
    );
  }
}

class _ReportCard extends StatelessWidget {
  const _ReportCard({required this.title, required this.report, required this.labels});

  final String title;
  final EvalReport report;
  final List<String> labels;

  @override
  Widget build(BuildContext context) {
    // The confusion matrix is indexed by the model's own label order, which
    // the training pipeline fixes as sorted(class_names), so read the axis
    // labels off the per-class report in that same sorted order rather than
    // assuming `labels` arrives sorted.
    final axis = report.perClass.keys.toList()..sort();

    return VidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          VidCardHeader(
            title: title,
            action: VidBadge(
              label: '${(report.accuracy * 100).toStringAsFixed(1)}%',
              tone: BadgeTone.primary,
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: DataTable(
              columnSpacing: 28,
              columns: const [
                DataColumn(label: Text('Action')),
                DataColumn(label: Text('Precision')),
                DataColumn(label: Text('Recall')),
                DataColumn(label: Text('F1')),
                DataColumn(label: Text('Support')),
              ],
              rows: axis.map((name) {
                final m = report.perClass[name]!;
                return DataRow(cells: [
                  DataCell(Text(name)),
                  DataCell(Text(m.precision.toStringAsFixed(2))),
                  DataCell(Text(m.recall.toStringAsFixed(2))),
                  DataCell(Text(m.f1.toStringAsFixed(2))),
                  DataCell(Text('${m.support}')),
                ]);
              }).toList(),
            ),
          ),
          if (report.confusionMatrix.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text(
              'Confusion matrix, rows are the true action, columns what the model predicted.',
              style: TextStyle(color: VidColors.neutral500, fontSize: 12),
            ),
            const SizedBox(height: 8),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: _ConfusionMatrix(matrix: report.confusionMatrix, axis: axis),
            ),
          ],
        ],
      ),
    );
  }
}

class _ConfusionMatrix extends StatelessWidget {
  const _ConfusionMatrix({required this.matrix, required this.axis});

  final List<List<int>> matrix;
  final List<String> axis;

  @override
  Widget build(BuildContext context) {
    final maxValue = matrix.expand((r) => r).fold<int>(0, (m, v) => v > m ? v : m);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const SizedBox(width: 120),
            ...axis.map((name) => SizedBox(
                  width: 56,
                  child: Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: TextStyle(color: VidColors.neutral500, fontSize: 11),
                  ),
                )),
          ],
        ),
        const SizedBox(height: 4),
        ...matrix.asMap().entries.map((rowEntry) {
          final i = rowEntry.key;
          return Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Row(
              children: [
                SizedBox(
                  width: 120,
                  child: Text(
                    i < axis.length ? axis[i] : '',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: VidColors.neutral500, fontSize: 11),
                  ),
                ),
                ...rowEntry.value.asMap().entries.map((cell) {
                  final onDiagonal = cell.key == i;
                  // Shade by magnitude so the diagonal (correct predictions)
                  // reads at a glance, with off-diagonal mistakes in red.
                  final intensity = maxValue == 0 ? 0.0 : cell.value / maxValue;
                  final base = onDiagonal ? VidColors.success : VidColors.danger;
                  return Container(
                    width: 54,
                    height: 30,
                    margin: const EdgeInsets.only(right: 2),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: cell.value == 0
                          ? VidColors.neutral100
                          : base.withValues(alpha: 0.12 + intensity * 0.38),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      '${cell.value}',
                      style: TextStyle(
                        color: cell.value == 0 ? VidColors.neutral400 : VidColors.text,
                        fontSize: 12,
                        fontFamily: 'monospace',
                      ),
                    ),
                  );
                }),
              ],
            ),
          );
        }),
      ],
    );
  }
}
