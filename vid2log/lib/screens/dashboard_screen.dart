/// Ported from frontend/app/dashboard/page.tsx, Overview/Models/Activity
/// tabs. Two things are simplified versus the web version, both because
/// there's genuinely less to show in a single-user offline app: "Trained /
/// registered models" is always 1 (the bundled default, see
/// python_sidecar/app/ml/default_model/), since local training isn't wired
/// up yet (Models screen explains this), and the Activity feed only has
/// video jobs, not training jobs, for the same reason.
library;

import 'package:flutter/material.dart';

import '../models/job.dart';
import '../models/training.dart';
import '../services/api_client.dart';
import '../shell/section.dart';
import '../widgets/ui.dart';

enum _DashTab { overview, models, activity }

class DashboardScreen extends StatefulWidget {
  const DashboardScreen({
    super.key,
    required this.apiClient,
    required this.onNavigate,
    required this.onOpenJob,
  });

  final ApiClient apiClient;
  final ValueChanged<AppSection> onNavigate;
  final ValueChanged<String> onOpenJob;

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  _DashTab _tab = _DashTab.overview;
  List<Job>? _jobs;
  List<ModelInfo>? _models;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        widget.apiClient.listJobs(),
        widget.apiClient.listModels(),
      ]);
      if (!mounted) return;
      setState(() {
        _jobs = results[0] as List<Job>;
        _models = results[1] as List<ModelInfo>;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '$e');
    }
  }

  String _fmtDate(String iso) {
    try {
      final d = DateTime.parse(iso).toLocal();
      return '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')} '
          '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    } catch (_) {
      return iso;
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
            eyebrow: 'Dashboard',
            title: 'Welcome',
            action: FilledButton.icon(
              onPressed: () => widget.onNavigate(AppSection.process),
              icon: const Icon(Icons.play_arrow, size: 18),
              label: const Text('Process a video'),
            ),
          ),
          VidTabs<_DashTab>(
            tabs: const [
              (_DashTab.overview, 'Overview'),
              (_DashTab.models, 'Models'),
              (_DashTab.activity, 'Activity'),
            ],
            active: _tab,
            onChange: (t) => setState(() => _tab = t),
          ),
          if (_error != null) ...[
            DangerAlert(message: _error!),
            const SizedBox(height: 16),
          ],
          if (_jobs == null)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 60),
              child: Center(child: CircularProgressIndicator()),
            )
          else
            switch (_tab) {
              _DashTab.overview => _buildOverview(),
              _DashTab.models => _buildModels(),
              _DashTab.activity => _buildActivity(),
            },
        ],
      ),
    );
  }

  Widget _buildOverview() {
    final jobs = _jobs!;
    final done = jobs.where((j) => j.status == JobStatus.done).length;
    final active = jobs
        .where((j) => j.status == JobStatus.queued || j.status == JobStatus.processing)
        .length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        LayoutBuilder(builder: (context, constraints) {
          final cols = constraints.maxWidth > 900 ? 4 : (constraints.maxWidth > 560 ? 2 : 1);
          final stats = [
            StatCard(label: 'Total jobs', value: '${jobs.length}'),
            StatCard(label: 'Completed', value: '$done'),
            StatCard(label: 'In progress', value: '$active'),
            StatCard(label: 'Registered models', value: '${_models?.length ?? 1}'),
          ];
          return GridView.count(
            crossAxisCount: cols,
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            crossAxisSpacing: 16,
            mainAxisSpacing: 16,
            childAspectRatio: 2.1,
            children: stats,
          );
        }),
        const SizedBox(height: 28),
        LayoutBuilder(builder: (context, constraints) {
          final wide = constraints.maxWidth > 800;
          final recentJobs = _buildRecentJobsCard(jobs);
          final quickActions = _buildQuickActionsCard();
          if (!wide) {
            return Column(children: [recentJobs, const SizedBox(height: 16), quickActions]);
          }
          return IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(flex: 2, child: recentJobs),
                const SizedBox(width: 16),
                Expanded(child: quickActions),
              ],
            ),
          );
        }),
      ],
    );
  }

  Widget _buildRecentJobsCard(List<Job> jobs) {
    return VidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          VidCardHeader(
            title: 'Recent jobs',
            action: TextButton(
              onPressed: () => widget.onNavigate(AppSection.process),
              child: const Text('View all'),
            ),
          ),
          if (jobs.isEmpty)
            EmptyStateWidget(
              title: 'No videos processed yet',
              action: FilledButton(
                onPressed: () => widget.onNavigate(AppSection.process),
                child: const Text('Process a video'),
              ),
            )
          else
            ...jobs.take(8).map((job) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: InkWell(
                    onTap: () => widget.onOpenJob(job.jobId),
                    child: Row(
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
                      ],
                    ),
                  ),
                )),
        ],
      ),
    );
  }

  Widget _buildQuickActionsCard() {
    return VidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const VidCardHeader(title: 'Quick actions'),
          _QuickAction(label: 'Train a new model', onTap: () => widget.onNavigate(AppSection.train)),
          const SizedBox(height: 8),
          _QuickAction(label: 'Process a video', onTap: () => widget.onNavigate(AppSection.process)),
          const SizedBox(height: 8),
          _QuickAction(label: 'Run pattern analysis', onTap: () => widget.onNavigate(AppSection.analytics)),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 16),
            child: Divider(height: 1, color: VidColors.neutral200),
          ),
          TextButton(onPressed: _load, child: const Text('Refresh')),
        ],
      ),
    );
  }

  Widget _buildModels() {
    final models = _models ?? const <ModelInfo>[];
    return VidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          VidCardHeader(
            title: 'Model registry',
            action: TextButton(
              onPressed: () => widget.onNavigate(AppSection.models),
              child: const Text('View all'),
            ),
          ),
          if (models.isEmpty)
            const EmptyStateWidget(title: 'No models yet')
          else
            ...models.map((m) {
              final headline = m.metrics?.headline;
              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    border: Border.all(color: VidColors.neutral200),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(m.name,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                    color: VidColors.text, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 2),
                            Text(
                              '${m.labels.length} action${m.labels.length == 1 ? '' : 's'}'
                              '${headline != null ? ' · test acc ${(headline.accuracy * 100).toStringAsFixed(1)}%' : ''}',
                              style: TextStyle(color: VidColors.neutral500, fontSize: 13),
                            ),
                          ],
                        ),
                      ),
                      if (m.isActive) const VidBadge(label: 'active', tone: BadgeTone.success),
                    ],
                  ),
                ),
              );
            }),
        ],
      ),
    );
  }

  Widget _buildActivity() {
    final jobs = [..._jobs!]..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return VidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const VidCardHeader(title: 'Activity'),
          if (jobs.isEmpty)
            const EmptyStateWidget(title: 'No activity yet')
          else
            ...jobs.take(20).map((job) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: InkWell(
                    onTap: () => widget.onOpenJob(job.jobId),
                    child: Row(
                      children: [
                        const VidBadge(label: 'Video', tone: BadgeTone.primary),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(job.originalFilename,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(color: VidColors.text, fontWeight: FontWeight.w500)),
                              Text(_fmtDate(job.createdAt),
                                  style: TextStyle(color: VidColors.neutral500, fontSize: 13)),
                            ],
                          ),
                        ),
                        StatusBadge(status: job.status),
                      ],
                    ),
                  ),
                )),
        ],
      ),
    );
  }
}

class _QuickAction extends StatelessWidget {
  const _QuickAction({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton(
        onPressed: onTap,
        style: OutlinedButton.styleFrom(alignment: Alignment.centerLeft),
        child: Text(label),
      ),
    );
  }
}
