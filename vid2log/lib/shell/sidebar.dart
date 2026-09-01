/// Ported from frontend/components/app-shell/Sidebar.tsx, same fixed
/// left rail, same nav order/labels, same active-item styling
/// (primary-tint background + primary-hover text). Deliberate differences
/// from the web version: no collapse/mobile-drawer logic (this is a
/// desktop-only app, the rail is always visible), and the account footer is
/// replaced with a light/dark theme toggle (there's no multi-account
/// concept in a single-user offline app, and the sidecar's running status
/// is surfaced instead via AppShell's failure banner, so it doesn't need a
/// permanent row here too).
library;

import 'package:flutter/material.dart';

import '../constants/copy.dart';
import '../theme/colors.dart';
import 'section.dart';

class Sidebar extends StatelessWidget {
  const Sidebar({
    super.key,
    required this.active,
    required this.onSelect,
  });

  final AppSection active;
  final ValueChanged<AppSection> onSelect;

  Widget _navItem(AppSection section, SectionMeta meta) {
    final isActive = section == active;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Tooltip(
        message: kNavTooltips[section] ?? '',
        waitDuration: const Duration(milliseconds: 400),
        child: Material(
          color: isActive ? VidColors.primaryTint : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
          child: InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => onSelect(section),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
              child: Row(
                children: [
                  Icon(
                    meta.icon,
                    size: 19,
                    color: isActive ? VidColors.primaryHover : VidColors.neutral500,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      meta.label,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w500,
                        color: isActive ? VidColors.primaryHover : VidColors.neutral500,
                      ),
                    ),
                  ),
                  if (!meta.implemented)
                    Text(
                      'soon',
                      style: TextStyle(fontSize: 11, color: VidColors.neutral400),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 240,
      decoration: BoxDecoration(
        color: VidColors.surface,
        border: Border(right: BorderSide(color: VidColors.neutral200)),
      ),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
            child: Row(
              children: [
                const _LogoMark(),
                const SizedBox(width: 8),
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
              children: [
                // The workflow items, in pipeline order.
                for (final e in kSections.entries)
                  if (e.key != AppSection.help) _navItem(e.key, e.value),
                // Help sits apart: it documents all of the above rather than
                // being another step in the sequence.
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
                  child: Divider(height: 1, color: VidColors.neutral200),
                ),
                if (kSections[AppSection.help] case final help?)
                  _navItem(AppSection.help, help),
              ],
            ),
          ),
          const _ThemeToggleRow(),
        ],
      ),
    );
  }
}

/// The shared brand logo, the same PNG the web app uses
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
          Icon(Icons.videocam_rounded, color: VidColors.primary, size: 22),
    );
  }
}

/// Light/dark toggle pinned to the sidebar's bottom-left corner. Mirrors
/// frontend/components/ThemeToggle.tsx's ThemeToggleButton: shows the icon
/// for the mode a click would SWITCH TO (sun while dark is active, moon
/// while light is active), not the currently-active mode.
class _ThemeToggleRow extends StatelessWidget {
  const _ThemeToggleRow();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: VidColors.neutral200)),
      ),
      child: ValueListenableBuilder<Brightness>(
        valueListenable: VidTheme.brightness,
        builder: (context, brightness, _) {
          final isLight = brightness == Brightness.light;
          return Align(
            alignment: Alignment.centerLeft,
            child: Tooltip(
              message: isLight ? 'Switch to dark mode' : 'Switch to light mode',
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: VidTheme.toggle,
                child: Container(
                  width: 36,
                  height: 36,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: VidColors.neutral200),
                  ),
                  child: Icon(
                    isLight ? Icons.dark_mode_outlined : Icons.light_mode_outlined,
                    size: 18,
                    color: VidColors.neutral600,
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
