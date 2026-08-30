/// Shared "work is happening, and how far along it is" progress primitives.
/// Used by every screen with a stage-driven background job (training,
/// action discovery) as well as generic long-running operations that have
/// no real percentage to report. Visual language mirrors
/// frontend/components/ui/ProgressBar.tsx (rounded track, gradient fill,
/// looping sweep for indeterminate work) but adds a percentage readout and
/// a "what's happening right now" label, which the web version doesn't
/// need since it can just re-render on every fetch tick.
library;

import 'package:flutter/material.dart';

import '../theme/colors.dart';

/// A rounded, gradient-filled progress bar that animates smoothly to a new
/// [fraction] instead of snapping, so stage-to-stage jumps (see the
/// checkpoint tables in models/training.dart) read as motion rather than a
/// glitch.
///
/// Pass a null [fraction] for work that's genuinely in progress but has no
/// real percentage to report yet (e.g. one awaited request with no
/// per-chunk feedback), a short highlight then sweeps the track on a loop
/// instead of sitting motionless, so it still reads as "actively working."
class VidProgressBar extends StatefulWidget {
  const VidProgressBar({super.key, this.fraction, this.height = 8});

  final double? fraction;
  final double height;

  @override
  State<VidProgressBar> createState() => _VidProgressBarState();
}

class _VidProgressBarState extends State<VidProgressBar> with SingleTickerProviderStateMixin {
  late final AnimationController _sweep = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );

  @override
  void initState() {
    super.initState();
    if (widget.fraction == null) _sweep.repeat();
  }

  @override
  void didUpdateWidget(covariant VidProgressBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    final indeterminate = widget.fraction == null;
    if (indeterminate && !_sweep.isAnimating) {
      _sweep.repeat();
    } else if (!indeterminate && _sweep.isAnimating) {
      _sweep.stop();
    }
  }

  @override
  void dispose() {
    _sweep.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(999);
    final gradient = LinearGradient(colors: [VidColors.primary, VidColors.primaryHover]);

    return Container(
      width: double.infinity,
      height: widget.height,
      decoration: BoxDecoration(
        borderRadius: radius,
        boxShadow: [
          BoxShadow(
            color: VidColors.primary.withValues(alpha: 0.32),
            blurRadius: 10,
            spreadRadius: -2,
          ),
        ],
      ),
      child: ClipRRect(
        borderRadius: radius,
        child: ColoredBox(
          color: VidColors.neutral200,
          child: widget.fraction != null
              ? Align(
                  alignment: Alignment.centerLeft,
                  child: TweenAnimationBuilder<double>(
                    tween: Tween(begin: 0, end: widget.fraction!.clamp(0.0, 1.0)),
                    duration: const Duration(milliseconds: 350),
                    curve: Curves.easeOut,
                    builder: (context, value, _) => FractionallySizedBox(
                      widthFactor: value,
                      heightFactor: 1,
                      child: DecoratedBox(decoration: BoxDecoration(gradient: gradient)),
                    ),
                  ),
                )
              : AnimatedBuilder(
                  animation: _sweep,
                  builder: (context, _) {
                    return LayoutBuilder(builder: (context, constraints) {
                      final trackWidth = constraints.maxWidth;
                      final segmentWidth = trackWidth * 0.3;
                      final t = Curves.easeInOut.transform(_sweep.value);
                      final left = -segmentWidth + t * (trackWidth + segmentWidth * 2);
                      return Stack(children: [
                        Positioned(
                          left: left,
                          width: segmentWidth,
                          top: 0,
                          bottom: 0,
                          child: DecoratedBox(
                            decoration: BoxDecoration(borderRadius: radius, gradient: gradient),
                          ),
                        ),
                      ]);
                    });
                  },
                ),
        ),
      ),
    );
  }
}

/// A small pulsing dot beside a stage label, a subtle "this is live"
/// affordance that reads calmer than a full spinner, matching the rest of
/// this design system's understated motion.
class _PulsingDot extends StatefulWidget {
  const _PulsingDot({this.color});

  final Color? color;

  @override
  State<_PulsingDot> createState() => _PulsingDotState();
}

class _PulsingDotState extends State<_PulsingDot> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  )..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final color = widget.color ?? VidColors.primary;
    return FadeTransition(
      opacity: Tween(begin: 0.35, end: 1.0).animate(
        CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
      ),
      child: Container(
        width: 8,
        height: 8,
        decoration: BoxDecoration(color: color, shape: BoxShape.circle),
      ),
    );
  }
}

/// The composite "here's what's happening, and how far along it is" block
/// shared by every screen with a stage-driven background job: a pulsing
/// status dot, the current stage's label, a percentage pill once a real
/// number is known, and the animated bar itself underneath.
///
/// Pass a null [fraction] when no percentage can be computed for the
/// current stage (see models/training.dart's `overallFraction`), the bar
/// then falls back to an indeterminate sweep instead of showing a
/// fabricated number, and the percentage pill is simply omitted.
class JobProgressPanel extends StatelessWidget {
  const JobProgressPanel({super.key, required this.label, this.fraction});

  final String label;
  final double? fraction;

  @override
  Widget build(BuildContext context) {
    final pct = fraction == null ? null : (fraction!.clamp(0.0, 1.0) * 100).round();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const _PulsingDot(),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: VidColors.neutral600, fontSize: 13, fontWeight: FontWeight.w500),
              ),
            ),
            if (pct != null) ...[
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: VidColors.primaryTint,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  '$pct%',
                  style: TextStyle(
                    color: VidColors.primaryHover,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    fontFamily: 'monospace',
                  ),
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 8),
        VidProgressBar(fraction: fraction),
      ],
    );
  }
}
