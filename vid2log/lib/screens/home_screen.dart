/// Home screen: sidecar connection status + the list of jobs stored in the
/// local SQLite db (python_sidecar/app/db.py). This is the app's landing
/// screen (see main.dart).
library;

import 'package:flutter/material.dart';

import '../models/job.dart';
import '../services/api_client.dart';
import '../services/sidecar_service.dart';
import 'job_detail_screen.dart';
import 'new_job_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.sidecar,
    required this.apiClient,
  });

  final SidecarService sidecar;
  final ApiClient apiClient;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<Job>? _jobs;
  String? _loadError;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() => _loading = true);
    try {
      final jobs = await widget.apiClient.listJobs();
      setState(() {
        _jobs = jobs;
        _loadError = null;
      });
    } catch (e) {
      setState(() => _loadError = '$e');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Color _statusColor(JobStatus status) {
    switch (status) {
      case JobStatus.queued:
        return Colors.grey;
      case JobStatus.processing:
        return Colors.orange;
      case JobStatus.done:
        return Colors.green;
      case JobStatus.failed:
        return Colors.red;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('vid2log'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: Column(
        children: [
          _SidecarStatusBar(sidecar: widget.sidecar),
          Expanded(child: _buildBody()),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          final created = await Navigator.of(context).push<bool>(
            MaterialPageRoute(
              builder: (_) => NewJobScreen(apiClient: widget.apiClient),
            ),
          );
          if (created == true) _refresh();
        },
        icon: const Icon(Icons.add),
        label: const Text('New job'),
      ),
    );
  }

  Widget _buildBody() {
    if (_loading && _jobs == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_loadError != null && _jobs == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.error_outline, size: 40, color: Colors.red),
              const SizedBox(height: 12),
              Text(
                'Could not load jobs: $_loadError',
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 12),
              OutlinedButton(onPressed: _refresh, child: const Text('Retry')),
            ],
          ),
        ),
      );
    }
    final jobs = _jobs ?? [];
    if (jobs.isEmpty) {
      return const Center(
        child: Text('No jobs yet — tap "New job" to process a video.'),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.separated(
        itemCount: jobs.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final job = jobs[i];
          return ListTile(
            leading: CircleAvatar(
              backgroundColor: _statusColor(job.status),
              radius: 6,
              child: const SizedBox.shrink(),
            ),
            title: Text(job.label),
            subtitle: Text(
              job.status.name +
                  (job.sceneCount != null ? ' · ${job.sceneCount} scenes' : ''),
            ),
            trailing: const Icon(Icons.chevron_right),
            onTap: () async {
              await Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => JobDetailScreen(
                    apiClient: widget.apiClient,
                    jobId: job.jobId,
                  ),
                ),
              );
              _refresh();
            },
          );
        },
      ),
    );
  }
}

class _SidecarStatusBar extends StatelessWidget {
  const _SidecarStatusBar({required this.sidecar});

  final SidecarService sidecar;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<SidecarState>(
      stream: sidecar.stateStream,
      initialData: sidecar.state,
      builder: (context, snapshot) {
        final state = snapshot.data ?? SidecarState.stopped;
        late final Color color;
        late final String label;
        switch (state) {
          case SidecarState.running:
            color = Colors.green;
            label = 'Local engine running — fully offline';
            break;
          case SidecarState.starting:
            color = Colors.orange;
            label = 'Starting local engine…';
            break;
          case SidecarState.failed:
            color = Colors.red;
            label = 'Local engine failed to start: ${sidecar.lastError ?? ''}';
            break;
          case SidecarState.stopped:
            color = Colors.grey;
            label = 'Local engine stopped';
            break;
        }
        return Container(
          width: double.infinity,
          color: color.withValues(alpha: 0.12),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          child: Row(
            children: [
              Icon(Icons.circle, size: 10, color: color),
              const SizedBox(width: 8),
              Expanded(
                child: Text(label, style: TextStyle(color: color.withValues(alpha: 1))),
              ),
              if (state == SidecarState.failed)
                TextButton(
                  onPressed: () => sidecar.start(),
                  child: const Text('Retry'),
                ),
            ],
          ),
        );
      },
    );
  }
}
