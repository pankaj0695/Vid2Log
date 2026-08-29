/// Ported from frontend/components/app-shell/AppShell.tsx — sidebar +
/// topbar chrome shared by every screen, with the actual page content
/// slotted in as [child]. Also surfaces a full-width banner when the
/// sidecar has failed to start, since every screen in this app is useless
/// without it (unlike the web app, there's no separate "is the backend up"
/// concern to show — the sidecar IS the backend).
library;

import 'package:flutter/material.dart';

import '../services/sidecar_service.dart';
import '../theme/colors.dart';
import 'section.dart';
import 'sidebar.dart';

class AppShell extends StatelessWidget {
  const AppShell({
    super.key,
    required this.section,
    required this.onSelectSection,
    required this.sidecar,
    required this.child,
  });

  final AppSection section;
  final ValueChanged<AppSection> onSelectSection;
  final SidecarService sidecar;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final meta = kSections[section]!;
    return Scaffold(
      backgroundColor: VidColors.bg,
      body: Row(
        children: [
          Sidebar(active: section, onSelect: onSelectSection, sidecar: sidecar),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  height: 52,
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  decoration: const BoxDecoration(
                    color: VidColors.surface,
                    border: Border(bottom: BorderSide(color: VidColors.neutral200)),
                  ),
                  child: Row(
                    children: [
                      Text(
                        meta.label,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                          color: VidColors.neutral500,
                        ),
                      ),
                    ],
                  ),
                ),
                _SidecarFailureBanner(sidecar: sidecar),
                Expanded(child: child),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SidecarFailureBanner extends StatelessWidget {
  const _SidecarFailureBanner({required this.sidecar});

  final SidecarService sidecar;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<SidecarState>(
      stream: sidecar.stateStream,
      initialData: sidecar.state,
      builder: (context, snapshot) {
        if (snapshot.data != SidecarState.failed) return const SizedBox.shrink();
        return Container(
          width: double.infinity,
          color: VidColors.dangerTint,
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 10),
          child: Row(
            children: [
              const Icon(Icons.error_outline, color: VidColors.danger, size: 18),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'Local engine failed to start: ${sidecar.lastError ?? "unknown error"}',
                  style: const TextStyle(color: VidColors.danger, fontSize: 13),
                ),
              ),
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
