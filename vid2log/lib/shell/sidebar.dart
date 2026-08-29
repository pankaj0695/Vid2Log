/// Ported from frontend/components/app-shell/Sidebar.tsx — same fixed
/// left rail, same nav order/labels, same active-item styling
/// (primary-tint background + primary-hover text). Two deliberate
/// differences from the web version: no collapse/mobile-drawer logic (this
/// is a desktop-only app, the rail is always visible), and the account
/// footer is replaced with a live sidecar status row, since there's no
/// multi-account concept in a single-user offline app.
library;

import 'package:flutter/material.dart';

import '../services/sidecar_service.dart';
import '../theme/colors.dart';
import 'section.dart';

class Sidebar extends StatelessWidget {
  const Sidebar({
    super.key,
    required this.active,
    required this.onSelect,
    required this.sidecar,
  });

  final AppSection active;
  final ValueChanged<AppSection> onSelect;
  final SidecarService sidecar;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 240,
      decoration: const BoxDecoration(
        color: VidColors.surface,
        border: Border(right: BorderSide(color: VidColors.neutral200)),
      ),
      child: Column(
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(20, 20, 20, 16),
            child: Row(
              children: [
                _LogoMark(),
                SizedBox(width: 8),
                Text(
                  'vid2log',
                  style: TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                    color: VidColors.text,
                  ),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              children: kSections.entries.map((e) {
                final isActive = e.key == active;
                return Padding(
                  padding: const EdgeInsets.only(bottom: 2),
                  child: Material(
                    color: isActive ? VidColors.primaryTint : Colors.transparent,
                    borderRadius: BorderRadius.circular(8),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(8),
                      onTap: () => onSelect(e.key),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
                        child: Row(
                          children: [
                            Icon(
                              e.value.icon,
                              size: 19,
                              color: isActive ? VidColors.primaryHover : VidColors.neutral500,
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: Text(
                                e.value.label,
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: FontWeight.w500,
                                  color: isActive ? VidColors.primaryHover : VidColors.neutral500,
                                ),
                              ),
                            ),
                            if (!e.value.implemented)
                              const Text(
                                'soon',
                                style: TextStyle(fontSize: 11, color: VidColors.neutral400),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              }).toList(),
            ),
          ),
          _SidecarStatusRow(sidecar: sidecar),
        ],
      ),
    );
  }
}

/// The shared brand logo — the same PNG the web app uses
/// (frontend/public/vid2log-logo.png, copied to assets/vid2log-logo.png
/// here; see pubspec.yaml). Falls back to an icon if the asset is missing
/// so a forgotten copy degrades gracefully instead of throwing a red
/// widget-error box in the sidebar.
class _LogoMark extends StatelessWidget {
  const _LogoMark();

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      'assets/vid2log-logo.png',
      width: 24,
      height: 24,
      filterQuality: FilterQuality.high,
      errorBuilder: (context, error, stackTrace) =>
          const Icon(Icons.videocam_rounded, color: VidColors.primary, size: 22),
    );
  }
}

class _SidecarStatusRow extends StatelessWidget {
  const _SidecarStatusRow({required this.sidecar});

  final SidecarService sidecar;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: VidColors.neutral200)),
      ),
      child: StreamBuilder<SidecarState>(
        stream: sidecar.stateStream,
        initialData: sidecar.state,
        builder: (context, snapshot) {
          final state = snapshot.data ?? SidecarState.stopped;
          late final Color color;
          late final String label;
          switch (state) {
            case SidecarState.running:
              color = VidColors.success;
              label = 'Running offline';
              break;
            case SidecarState.starting:
              color = VidColors.warning;
              label = 'Starting…';
              break;
            case SidecarState.failed:
              color = VidColors.danger;
              label = 'Engine failed';
              break;
            case SidecarState.stopped:
              color = VidColors.neutral500;
              label = 'Stopped';
              break;
          }
          return Row(
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  label,
                  style: const TextStyle(fontSize: 13, color: VidColors.neutral500, fontWeight: FontWeight.w500),
                ),
              ),
              if (state == SidecarState.failed)
                IconButton(
                  onPressed: () => sidecar.start(),
                  icon: const Icon(Icons.refresh_rounded, size: 18, color: VidColors.neutral500),
                  tooltip: 'Retry',
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                ),
            ],
          );
        },
      ),
    );
  }
}
