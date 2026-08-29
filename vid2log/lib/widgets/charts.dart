/// Chart primitives ported from frontend/components/ui/charts.tsx — bar,
/// horizontal bar, donut, and the Gantt-style scene timeline. Same
/// dependency-free approach as the web version: everything is drawn with
/// plain Flutter widgets/CustomPaint, no charting package.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/colors.dart';

/// The qualitative palette from charts.tsx's CATEGORY_PALETTE, in the same
/// order so a given action gets the same colour in both apps.
const List<Color> kCategoryPalette = [
  Color(0xFF2DD4BF), // teal
  Color(0xFF38BDF8), // sky
  Color(0xFFFBBF24), // amber
  Color(0xFFF87171), // rose
  Color(0xFFA78BFA), // violet
  Color(0xFF34D399), // emerald
  Color(0xFFF472B6), // pink
  Color(0xFF60A5FA), // blue
];

/// Assigns every label its own colour, keyed by POSITION in [labels] rather
/// than by hashing the label text.
///
/// Hashing was the earlier approach and it was wrong: two different actions
/// could hash to the same palette slot and render identically, which is
/// exactly the thing a categorical colour scale must never do. Index-based
/// assignment guarantees the first eight are distinct, and past that this
/// generates additional evenly-spaced hues instead of wrapping around the
/// palette — so a log with 20 actions still gets 20 visually distinct
/// colours (the web version wraps at 8; this is a deliberate improvement,
/// not a divergence in behaviour).
///
/// Pass a stable, deterministic [labels] order (sorted, or first-appearance
/// order) so the same action keeps its colour between rebuilds.
Map<String, Color> buildColorMap(Iterable<String> labels) {
  final map = <String, Color>{};
  var i = 0;
  for (final label in labels) {
    if (map.containsKey(label)) continue;
    if (i < kCategoryPalette.length) {
      map[label] = kCategoryPalette[i];
    } else {
      // Golden-angle hue stepping spreads extra colours as far apart as
      // possible rather than clustering them; the alternating lightness
      // keeps neighbouring generated colours distinguishable too.
      final n = i - kCategoryPalette.length;
      final hue = (n * 137.508) % 360;
      final lightness = n.isEven ? 0.62 : 0.48;
      map[label] = HSLColor.fromAHSL(1, hue, 0.62, lightness).toColor();
    }
    i++;
  }
  return map;
}

class ChartDatum {
  const ChartDatum({required this.label, required this.value, this.hint});
  final String label;
  final num value;
  final String? hint;
}

/// Vertical bar chart — charts.tsx's BarChart.
class BarChart extends StatelessWidget {
  const BarChart({super.key, required this.data, this.colors, this.height = 200});

  final List<ChartDatum> data;
  final Map<String, Color>? colors;
  final double height;

  @override
  Widget build(BuildContext context) {
    if (data.isEmpty) return const SizedBox.shrink();
    final max = data.map((d) => d.value).reduce((a, b) => a > b ? a : b);
    final palette = colors ?? buildColorMap(data.map((d) => d.label));

    return SizedBox(
      height: height,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: data.map((d) {
          final barHeight =
              math.max(4.0, (d.value / (max == 0 ? 1 : max)) * (height - 46));
          return Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  Text('${d.value}',
                      style: const TextStyle(
                          color: VidColors.neutral500, fontSize: 11, fontFamily: 'monospace')),
                  const SizedBox(height: 4),
                  Tooltip(
                    message: '${d.label}: ${d.value}',
                    child: Container(
                      height: barHeight,
                      decoration: BoxDecoration(
                        color: palette[d.label] ?? VidColors.primary,
                        borderRadius: const BorderRadius.vertical(top: Radius.circular(6)),
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    d.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: VidColors.neutral500, fontSize: 11),
                  ),
                ],
              ),
            ),
          );
        }).toList(),
      ),
    );
  }
}

/// Ranked horizontal bars — charts.tsx's HorizontalBarChart. Labels get the
/// full row width and wrap instead of truncating, since a long pattern or
/// filename cropped mid-way defeats the point of showing it.
class HorizontalBarChart extends StatelessWidget {
  const HorizontalBarChart({super.key, required this.data, this.colors});

  final List<ChartDatum> data;
  final Map<String, Color>? colors;

  @override
  Widget build(BuildContext context) {
    if (data.isEmpty) return const SizedBox.shrink();
    final max = data.map((d) => d.value).reduce((a, b) => a > b ? a : b);
    final palette = colors ?? buildColorMap(data.map((d) => d.label));

    return Column(
      children: data.map((d) {
        final fraction = max == 0 ? 0.0 : (d.value / max).toDouble().clamp(0.0, 1.0);
        return Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(d.label,
                        style: const TextStyle(color: VidColors.text, fontSize: 12)),
                  ),
                  Text(d.hint ?? '${d.value}',
                      style: const TextStyle(
                          color: VidColors.neutral500, fontSize: 11, fontFamily: 'monospace')),
                ],
              ),
              const SizedBox(height: 4),
              ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: LinearProgressIndicator(
                  value: fraction,
                  minHeight: 8,
                  backgroundColor: VidColors.neutral100,
                  valueColor:
                      AlwaysStoppedAnimation(palette[d.label] ?? VidColors.primary),
                ),
              ),
            ],
          ),
        );
      }).toList(),
    );
  }
}

/// Donut chart with a legend — charts.tsx's DonutChart.
class DonutChart extends StatelessWidget {
  const DonutChart({super.key, required this.data, this.colors, this.size = 132});

  final List<ChartDatum> data;
  final Map<String, Color>? colors;
  final double size;

  @override
  Widget build(BuildContext context) {
    final total = data.fold<double>(0, (s, d) => s + d.value);
    if (data.isEmpty || total == 0) return const SizedBox.shrink();
    final palette = colors ?? buildColorMap(data.map((d) => d.label));

    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        SizedBox(
          width: size,
          height: size,
          child: CustomPaint(
            painter: _DonutPainter(
              data: data,
              total: total,
              colors: palette,
            ),
          ),
        ),
        const SizedBox(width: 20),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: data.map((d) {
              final pct = (d.value / total * 100).toStringAsFixed(0);
              return Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  children: [
                    Container(
                      width: 10,
                      height: 10,
                      decoration: BoxDecoration(
                        color: palette[d.label] ?? VidColors.primary,
                        shape: BoxShape.circle,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(d.label,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: VidColors.text, fontSize: 13)),
                    ),
                    Text('$pct%',
                        style: const TextStyle(
                            color: VidColors.neutral500,
                            fontSize: 12,
                            fontFamily: 'monospace')),
                  ],
                ),
              );
            }).toList(),
          ),
        ),
      ],
    );
  }
}

class _DonutPainter extends CustomPainter {
  _DonutPainter({required this.data, required this.total, required this.colors});

  final List<ChartDatum> data;
  final double total;
  final Map<String, Color> colors;

  @override
  void paint(Canvas canvas, Size size) {
    const strokeWidth = 18.0;
    final radius = (size.shortestSide - strokeWidth) / 2;
    final center = Offset(size.width / 2, size.height / 2);
    final rect = Rect.fromCircle(center: center, radius: radius);

    canvas.drawCircle(
      center,
      radius,
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = strokeWidth
        ..color = VidColors.neutral100,
    );

    var startAngle = -math.pi / 2; // 12 o'clock, matching the web version
    for (final d in data) {
      final sweep = (d.value / total) * 2 * math.pi;
      canvas.drawArc(
        rect,
        startAngle,
        sweep,
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = strokeWidth
          ..color = colors[d.label] ?? VidColors.primary,
      );
      startAngle += sweep;
    }
  }

  @override
  bool shouldRepaint(covariant _DonutPainter old) =>
      old.data != data || old.total != total || old.colors != colors;
}

class TimelineSegment {
  const TimelineSegment({
    required this.label,
    required this.startSec,
    required this.endSec,
    required this.detail,
  });

  final String label;
  final double startSec;
  final double endSec;

  /// Extra lines for the hover tooltip (confidence, source, etc.).
  final String detail;
}

/// Gantt-style scene timeline — charts.tsx's GanttTimeline. Segments are
/// positioned by their real start/end times (not just stacked by duration),
/// so gaps and pacing read correctly, with a time axis beneath and the
/// non-hovered segments dimmed while pointing at one.
class GanttTimeline extends StatefulWidget {
  const GanttTimeline({
    super.key,
    required this.segments,
    required this.totalSeconds,
    required this.colors,
    this.height = 80,
    this.tickCount = 8,
  });

  final List<TimelineSegment> segments;
  final double totalSeconds;
  final Map<String, Color> colors;
  final double height;
  final int tickCount;

  @override
  State<GanttTimeline> createState() => _GanttTimelineState();
}

class _GanttTimelineState extends State<GanttTimeline> {
  int? _hovered;

  static String _clock(double totalSeconds) {
    final t = totalSeconds.round();
    final h = t ~/ 3600;
    final m = (t % 3600) ~/ 60;
    final s = t % 60;
    final mm = m.toString().padLeft(2, '0');
    final ss = s.toString().padLeft(2, '0');
    return h > 0 ? '$h:$mm:$ss' : '$mm:$ss';
  }

  @override
  Widget build(BuildContext context) {
    final total = widget.totalSeconds <= 0 ? 1.0 : widget.totalSeconds;
    final labels = <String>{for (final s in widget.segments) s.label};

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        LayoutBuilder(builder: (context, constraints) {
          final width = constraints.maxWidth;
          return SizedBox(
            height: widget.height,
            child: Stack(
              children: [
                Positioned.fill(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: VidColors.neutral100,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: VidColors.neutral200),
                    ),
                  ),
                ),
                ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: Stack(
                    children: [
                      for (var i = 0; i < widget.segments.length; i++)
                        _buildSegment(i, widget.segments[i], width, total),
                    ],
                  ),
                ),
              ],
            ),
          );
        }),
        const SizedBox(height: 6),
        LayoutBuilder(builder: (context, constraints) {
          return SizedBox(
            height: 16,
            child: Stack(
              children: [
                for (var i = 0; i <= widget.tickCount; i++)
                  Positioned(
                    left: (constraints.maxWidth * i / widget.tickCount)
                        // Nudge the first/last labels inward so they don't
                        // hang off either end of the chart.
                        .clamp(0.0, constraints.maxWidth - 42),
                    child: Text(
                      _clock(total * i / widget.tickCount),
                      style: const TextStyle(
                          color: VidColors.neutral500, fontSize: 10, fontFamily: 'monospace'),
                    ),
                  ),
              ],
            ),
          );
        }),
        const SizedBox(height: 12),
        Wrap(
          spacing: 14,
          runSpacing: 6,
          children: labels
              .map((label) => Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 10,
                        height: 10,
                        decoration: BoxDecoration(
                          color: widget.colors[label] ?? VidColors.primary,
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(label,
                          style:
                              const TextStyle(color: VidColors.neutral600, fontSize: 12)),
                    ],
                  ))
              .toList(),
        ),
      ],
    );
  }

  Widget _buildSegment(int i, TimelineSegment s, double width, double total) {
    final left = (s.startSec / total) * width;
    // A minimum width keeps a one-second blip visible and hoverable rather
    // than collapsing to nothing.
    final segWidth = math.max(2.0, ((s.endSec - s.startSec) / total) * width);
    final dimmed = _hovered != null && _hovered != i;

    return Positioned(
      left: left,
      width: segWidth,
      top: 0,
      bottom: 0,
      child: MouseRegion(
        onEnter: (_) => setState(() => _hovered = i),
        onExit: (_) => setState(() {
          if (_hovered == i) _hovered = null;
        }),
        child: Tooltip(
          message: '${s.label}\n'
              '${_clock(s.startSec)} – ${_clock(s.endSec)}\n'
              '${s.detail}',
          child: AnimatedOpacity(
            duration: const Duration(milliseconds: 120),
            opacity: dimmed ? 0.45 : 1,
            child: Container(
              margin: const EdgeInsets.only(right: 1),
              color: widget.colors[s.label] ?? VidColors.primary,
            ),
          ),
        ),
      ),
    );
  }
}
