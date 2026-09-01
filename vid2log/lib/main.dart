import 'package:flutter/material.dart';

import 'screens/analytics_screen.dart';
import 'screens/create_actions_screen.dart';
import 'screens/dashboard_screen.dart';
import 'screens/job_detail_screen.dart';
import 'screens/detectors_screen.dart';
import 'screens/help_screen.dart';
import 'screens/process_screen.dart';
import 'screens/train_screen.dart';
import 'screens/video_logs_screen.dart';
import 'services/api_client.dart';
import 'services/sidecar_service.dart';
import 'shell/app_shell.dart';
import 'shell/help_navigator.dart';
import 'shell/section.dart';
import 'theme/app_theme.dart';
import 'theme/colors.dart';

void main() {
  runApp(const Vid2LogApp());
}

class Vid2LogApp extends StatefulWidget {
  const Vid2LogApp({super.key});

  @override
  State<Vid2LogApp> createState() => _Vid2LogAppState();
}

class _Vid2LogAppState extends State<Vid2LogApp> with WidgetsBindingObserver {
  late final SidecarService _sidecar;
  late final ApiClient _apiClient;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _sidecar = SidecarService();
    _apiClient = ApiClient(
      // Passed as a callback, not a value: the sidecar picks a free port at
      // launch and reports it back, so there is nothing to read here yet.
      baseUrl: () => _sidecar.baseUrl,
      // Gate every request on the sidecar actually being up, see
      // ApiClient.waitUntilReady's doc comment for why this matters on a
      // cold start.
      waitUntilReady: _sidecar.waitUntilReady,
    );
    // Fire the sidecar up as soon as the app launches, every screen's own
    // status indicator (sidebar's bottom row, plus the failure banner in
    // AppShell) reflects _sidecar.stateStream live, so the UI doesn't need
    // to block on this.
    _sidecar.start();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Make sure a stray python process never outlives the Flutter window,
    // desktop apps get `detached` right before process exit.
    if (state == AppLifecycleState.detached) {
      _sidecar.stop();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _apiClient.close();
    _sidecar.stop();
    _sidecar.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Rebuilds the whole tree whenever the light/dark toggle flips (see
    // shell/sidebar.dart), so buildAppTheme() and every VidColors.* getter
    // re-resolve against the new palette.
    return ValueListenableBuilder<Brightness>(
      valueListenable: VidTheme.brightness,
      builder: (context, brightness, _) {
        return MaterialApp(
          title: 'Vid2Log',
          debugShowCheckedModeBanner: false,
          theme: buildAppTheme(),
          home: HomeShell(sidecar: _sidecar, apiClient: _apiClient),
        );
      },
    );
  }
}

/// Owns which sidebar section is active and renders the matching screen
/// inside the shared AppShell chrome, the Flutter equivalent of the web
/// app's per-route pages all wrapping themselves in the same <AppShell>
/// (see frontend/components/app-shell/AppShell.tsx).
class HomeShell extends StatefulWidget {
  const HomeShell({super.key, required this.sidecar, required this.apiClient});

  final SidecarService sidecar;
  final ApiClient apiClient;

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  AppSection _section = AppSection.dashboard;

  /// Which Help section to scroll to when Help is the active section. Set by
  /// the `?` button on another screen (see shell/help_navigator.dart); null
  /// when Help was opened from the sidebar, which starts at the top.
  String? _helpSection;

  void _openHelp(String sectionId) {
    setState(() {
      _section = AppSection.help;
      _helpSection = sectionId;
    });
  }

  void _openJob(String jobId) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => JobDetailScreen(apiClient: widget.apiClient, jobId: jobId),
      ),
    );
  }

  Widget _buildContent() {
    switch (_section) {
      case AppSection.dashboard:
        return DashboardScreen(
          apiClient: widget.apiClient,
          onNavigate: (s) => setState(() => _section = s),
          onOpenJob: _openJob,
        );
      case AppSection.createActions:
        return CreateActionsScreen(apiClient: widget.apiClient);
      case AppSection.train:
        return TrainScreen(
          apiClient: widget.apiClient,
          onOpenModels: () => setState(() => _section = AppSection.detectors),
        );
      case AppSection.detectors:
        return DetectorsScreen(apiClient: widget.apiClient);
      case AppSection.process:
        return ProcessScreen(
          apiClient: widget.apiClient,
          onOpenJob: _openJob,
          onNavigate: (s) => setState(() => _section = s),
        );
      case AppSection.videoLogs:
        return VideoLogsScreen(apiClient: widget.apiClient);
      case AppSection.analytics:
        return AnalyticsScreen(apiClient: widget.apiClient);
      case AppSection.help:
        return HelpScreen(initialSection: _helpSection);
    }
  }

  @override
  Widget build(BuildContext context) {
    return HelpNavigator(
      openHelp: _openHelp,
      child: AppShell(
        section: _section,
        // Choosing Help from the sidebar clears any pending deep-link target,
        // so it opens at the top rather than wherever the last `?` pointed.
        onSelectSection: (s) => setState(() {
          _section = s;
          if (s == AppSection.help) _helpSection = null;
        }),
        sidecar: widget.sidecar,
        child: _buildContent(),
      ),
    );
  }
}
