/// Shared UI primitives ported from the web app's design system
/// (frontend/components/ui/*.tsx) — Card, Badge/StatusBadge, Tabs,
/// PageHeader, EmptyState, StatCard, plus a new ComingSoonCard for the
/// sections that don't have a working sidecar backend yet (see
/// train_screen.dart / create_actions_screen.dart / analytics_screen.dart).
library;

import 'package:flutter/material.dart';

import '../models/job.dart';
import '../theme/colors.dart';

// Re-exported so every screen that imports this file for VidCard/StatusBadge/
// etc. also gets VidColors in scope, instead of each screen needing its own
// separate `import '../theme/colors.dart';` line.
export '../theme/colors.dart';

/// frontend/components/ui/Card.tsx — a bordered, softly-rounded panel; the
/// design system uses borders instead of shadows for resting-state depth.
class VidCard extends StatelessWidget {
  const VidCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
  });

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: VidColors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: VidColors.neutral200),
      ),
      child: child,
    );
  }
}

/// frontend/components/ui/Card.tsx's CardHeader.
class VidCardHeader extends StatelessWidget {
  const VidCardHeader({super.key, required this.title, this.action});

  final String title;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w600,
              color: VidColors.text,
            ),
          ),
          if (action != null) action!,
        ],
      ),
    );
  }
}

/// frontend/components/ui/Section.tsx's PageHeader — small-caps eyebrow +
/// large title + optional trailing action button.
class PageHeader extends StatelessWidget {
  const PageHeader({
    super.key,
    required this.eyebrow,
    required this.title,
    this.action,
  });

  final String eyebrow;
  final String title;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  eyebrow.toUpperCase(),
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 0.8,
                    color: VidColors.primary,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w700,
                    color: VidColors.text,
                    letterSpacing: -0.2,
                  ),
                ),
              ],
            ),
          ),
          if (action != null) action!,
        ],
      ),
    );
  }
}

/// frontend/components/ui/Tabs.tsx — a row of pill tabs; the active one
/// gets a primary-tint fill (same visual language as the sidebar's active
/// nav item).
class VidTabs<T> extends StatelessWidget {
  const VidTabs({
    super.key,
    required this.tabs,
    required this.active,
    required this.onChange,
  });

  final List<(T id, String label)> tabs;
  final T active;
  final ValueChanged<T> onChange;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: Wrap(
        spacing: 4,
        children: tabs.map((t) {
          final isActive = t.$1 == active;
          return Material(
            color: isActive ? VidColors.primaryTint : Colors.transparent,
            borderRadius: BorderRadius.circular(8),
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () => onChange(t.$1),
              child: Padding(
                padding:
                    const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                child: Text(
                  t.$2,
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: isActive ? VidColors.primaryHover : VidColors.neutral500,
                  ),
                ),
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}

enum BadgeTone { primary, secondary, success, warning, danger, neutral }

const Map<BadgeTone, Color> _badgeBg = {
  BadgeTone.primary: VidColors.primaryTint,
  BadgeTone.secondary: VidColors.secondaryTint,
  BadgeTone.success: VidColors.successTint,
  BadgeTone.warning: VidColors.warningTint,
  BadgeTone.danger: VidColors.dangerTint,
  BadgeTone.neutral: VidColors.neutral100,
};

const Map<BadgeTone, Color> _badgeFg = {
  BadgeTone.primary: VidColors.primaryHover,
  BadgeTone.secondary: VidColors.secondaryHover,
  BadgeTone.success: VidColors.success,
  BadgeTone.warning: VidColors.warning,
  BadgeTone.danger: VidColors.danger,
  BadgeTone.neutral: VidColors.neutral700,
};

/// frontend/components/ui/Badge.tsx
class VidBadge extends StatelessWidget {
  const VidBadge({super.key, required this.label, this.tone = BadgeTone.neutral, this.dot = false});

  final String label;
  final BadgeTone tone;
  final bool dot;

  @override
  Widget build(BuildContext context) {
    final fg = _badgeFg[tone]!;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: _badgeBg[tone],
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot) ...[
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(color: fg, shape: BoxShape.circle),
            ),
            const SizedBox(width: 6),
          ],
          Text(label, style: TextStyle(color: fg, fontSize: 13, fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }
}

/// frontend/components/ui/Badge.tsx's StatusBadge — maps job status
/// strings to a consistent tone (see python_sidecar/app/db.py for the
/// status values this handles: queued/processing/done/failed).
class StatusBadge extends StatelessWidget {
  const StatusBadge({super.key, required this.status});

  final JobStatus status;

  BadgeTone get _tone {
    switch (status) {
      case JobStatus.queued:
        return BadgeTone.neutral;
      case JobStatus.processing:
        return BadgeTone.primary;
      case JobStatus.done:
        return BadgeTone.success;
      case JobStatus.failed:
        return BadgeTone.danger;
    }
  }

  @override
  Widget build(BuildContext context) {
    return VidBadge(label: status.name, tone: _tone, dot: true);
  }
}

/// frontend/components/ui/EmptyState.tsx
class EmptyStateWidget extends StatelessWidget {
  const EmptyStateWidget({super.key, required this.title, this.subtitle, this.action});

  final String title;
  final String? subtitle;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              title,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: VidColors.text,
              ),
            ),
            if (subtitle != null) ...[
              const SizedBox(height: 6),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: VidColors.neutral500, fontSize: 14),
              ),
            ],
            if (action != null) ...[
              const SizedBox(height: 16),
              action!,
            ],
          ],
        ),
      ),
    );
  }
}

/// frontend/components/ui/StatCard.tsx
class StatCard extends StatelessWidget {
  const StatCard({super.key, required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return VidCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: VidColors.neutral500, fontSize: 14, fontWeight: FontWeight.w500)),
          const SizedBox(height: 8),
          Text(
            value,
            style: const TextStyle(
              fontFamily: 'monospace',
              fontSize: 32,
              fontWeight: FontWeight.w600,
              color: VidColors.text,
            ),
          ),
        ],
      ),
    );
  }
}

/// New: placeholder for sections whose sidecar backend isn't implemented
/// yet (training, action discovery, SPM/DSM analytics — see
/// FLUTTER_OFFLINE_FEASIBILITY.md Phases 2-3). Styled to match the rest of
/// the app rather than reading as a broken/unfinished page.
class ComingSoonCard extends StatelessWidget {
  const ComingSoonCard({
    super.key,
    required this.icon,
    required this.title,
    required this.description,
    required this.phase,
  });

  final IconData icon;
  final String title;
  final String description;
  final String phase;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 480),
        child: VidCard(
          padding: const EdgeInsets.all(32),
          child: Column(
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  color: VidColors.primaryTint,
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Icon(icon, color: VidColors.primaryHover, size: 26),
              ),
              const SizedBox(height: 20),
              Text(
                title,
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: VidColors.text),
              ),
              const SizedBox(height: 8),
              Text(
                description,
                textAlign: TextAlign.center,
                style: const TextStyle(color: VidColors.neutral500, fontSize: 14, height: 1.5),
              ),
              const SizedBox(height: 16),
              VidBadge(label: phase, tone: BadgeTone.secondary),
            ],
          ),
        ),
      ),
    );
  }
}

/// frontend/components/ui/Alert.tsx (danger tone only — the only one used
/// so far in this app).
class DangerAlert extends StatelessWidget {
  const DangerAlert({super.key, required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: VidColors.dangerTint,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Text(message, style: const TextStyle(color: VidColors.danger, fontSize: 14)),
    );
  }
}
