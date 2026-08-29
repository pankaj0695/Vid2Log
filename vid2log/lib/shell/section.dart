/// Mirrors frontend/components/app-shell/Sidebar.tsx's `SectionId` union —
/// same 7 sections, same order. "Admin" is intentionally left out: it only
/// exists in the web app to manage *other* cloud accounts, and this app is
/// a single local user with no accounts at all.
library;

import 'package:flutter/material.dart';

enum AppSection {
  dashboard,
  createActions,
  train,
  models,
  process,
  videoLogs,
  analytics,
}

class SectionMeta {
  const SectionMeta({
    required this.label,
    required this.icon,
    required this.implemented,
  });

  final String label;
  final IconData icon;
  /// False for sections whose sidecar backend doesn't exist yet (training,
  /// action discovery, SPM/DSM analytics — see FLUTTER_OFFLINE_FEASIBILITY.md
  /// Phases 2-3). Still shown in the sidebar, but routes to a "coming soon"
  /// screen instead of a broken one.
  final bool implemented;
}

const Map<AppSection, SectionMeta> kSections = {
  AppSection.dashboard: SectionMeta(
    label: 'Dashboard',
    icon: Icons.grid_view_rounded,
    implemented: true,
  ),
  AppSection.createActions: SectionMeta(
    label: 'Create actions',
    icon: Icons.hub_outlined,
    implemented: true,
  ),
  AppSection.train: SectionMeta(
    label: 'Train',
    icon: Icons.tune_rounded,
    implemented: true,
  ),
  AppSection.models: SectionMeta(
    label: 'Models',
    icon: Icons.inventory_2_outlined,
    implemented: true,
  ),
  AppSection.process: SectionMeta(
    label: 'Process video',
    icon: Icons.movie_creation_outlined,
    implemented: true,
  ),
  AppSection.videoLogs: SectionMeta(
    label: 'Video logs',
    icon: Icons.list_alt_rounded,
    implemented: true,
  ),
  AppSection.analytics: SectionMeta(
    label: 'Analytics',
    icon: Icons.bar_chart_rounded,
    implemented: true,
  ),
};
