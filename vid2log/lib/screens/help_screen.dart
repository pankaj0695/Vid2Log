/// The offline app's built-in documentation — the desktop counterpart of the
/// web app's /help page, rendering the same content from
/// constants/help_content.dart.
///
/// Deep-linking works by GlobalKey rather than URL fragment: every section
/// gets a key, and [HelpScreen.initialSection] scrolls that key into view
/// after the first frame. See shell/help_navigator.dart for how a `?` button
/// on another screen reaches this.
library;

import 'package:flutter/material.dart';

import '../constants/copy.dart';
import '../constants/help_content.dart';
import '../widgets/ui.dart';

class HelpScreen extends StatefulWidget {
  const HelpScreen({super.key, this.initialSection});

  /// Section id to scroll to on open. Null means start at the top.
  final String? initialSection;

  @override
  State<HelpScreen> createState() => _HelpScreenState();
}

class _HelpScreenState extends State<HelpScreen> {
  final _scrollController = ScrollController();
  final _keys = {for (final s in kHelpSections) s.id: GlobalKey()};

  @override
  void initState() {
    super.initState();
    _jumpTo(widget.initialSection, animate: false);
  }

  @override
  void didUpdateWidget(HelpScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Pressing `?` on another screen while Help is already the active section
    // rebuilds this widget with a new target rather than remounting it.
    if (widget.initialSection != oldWidget.initialSection) {
      _jumpTo(widget.initialSection, animate: true);
    }
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _jumpTo(String? id, {required bool animate}) {
    final key = id == null ? null : _keys[id];
    if (key == null) return;
    // On first build the target isn't laid out yet, so wait a frame. Using
    // ensureVisible (rather than computing an offset) keeps this correct no
    // matter how tall the sections above it turn out to be.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final target = key.currentContext;
      if (target == null || !mounted) return;
      Scrollable.ensureVisible(
        target,
        duration: animate ? const Duration(milliseconds: 320) : Duration.zero,
        curve: Curves.easeOutCubic,
        alignment: 0.02, // pin just below the top edge
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      controller: _scrollController,
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PageHeader(
            eyebrow: 'Help',
            subtitle: kPageSubtitles['help'],
            title: 'Vid2Log user guide',
          ),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 660),
            child: Container(
              padding: const EdgeInsets.only(left: 14),
              decoration: BoxDecoration(
                border: Border(left: BorderSide(color: VidColors.primary, width: 2)),
              ),
              child: Text(
                kHelpIntro,
                style: TextStyle(color: VidColors.neutral600, fontSize: 14, height: 1.65),
              ),
            ),
          ),
          const SizedBox(height: 8),
          for (var i = 0; i < kHelpSections.length; i++)
            _SectionBlock(
              key: _keys[kHelpSections[i].id],
              section: kHelpSections[i],
              number: i + 1,
            ),
        ],
      ),
    );
  }
}

class _SectionBlock extends StatelessWidget {
  const _SectionBlock({super.key, required this.section, required this.number});

  final HelpSection section;
  final int number;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 28),
        Divider(height: 1, color: VidColors.neutral200),
        const SizedBox(height: 22),
        Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            Text(
              number.toString().padLeft(2, '0'),
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w700,
                fontFamily: 'monospace',
                color: VidColors.primary,
              ),
            ),
            const SizedBox(width: 12),
            Text(
              section.title,
              style: TextStyle(
                fontSize: 21,
                fontWeight: FontWeight.w700,
                color: VidColors.text,
                letterSpacing: -0.2,
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 660),
          child: Text(
            section.blurb,
            style: TextStyle(color: VidColors.neutral600, fontSize: 14, height: 1.6),
          ),
        ),
        if (section.figure != null) ...[
          const SizedBox(height: 14),
          HelpFigureView(figure: section.figure!),
        ],
        for (final group in section.groups) ...[
          const SizedBox(height: 16),
          if (group.heading != null) ...[
            Text(
              group.heading!,
              style: TextStyle(
                fontSize: 14.5,
                fontWeight: FontWeight.w600,
                color: VidColors.text,
              ),
            ),
            const SizedBox(height: 10),
          ],
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 660),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var i = 0; i < group.items.length; i++)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          width: 20,
                          height: 20,
                          alignment: Alignment.center,
                          margin: const EdgeInsets.only(right: 10, top: 1),
                          decoration: BoxDecoration(
                            color: VidColors.primaryTint,
                            shape: BoxShape.circle,
                          ),
                          child: Text(
                            '${i + 1}',
                            style: TextStyle(
                              color: VidColors.primaryHover,
                              fontWeight: FontWeight.w700,
                              fontSize: 11,
                            ),
                          ),
                        ),
                        Expanded(
                          child: Text(
                            group.items[i],
                            style: TextStyle(
                              color: VidColors.neutral600,
                              fontSize: 13.5,
                              height: 1.55,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          if (group.figure != null) ...[
            const SizedBox(height: 12),
            HelpFigureView(figure: group.figure!),
          ],
        ],
        if (section.terms.isNotEmpty) ...[
          const SizedBox(height: 20),
          Text(
            section.termsHeading ?? 'Reference',
            style: TextStyle(
              fontSize: 14.5,
              fontWeight: FontWeight.w600,
              color: VidColors.text,
            ),
          ),
          const SizedBox(height: 10),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 660),
            child: Container(
              decoration: BoxDecoration(
                border: Border.all(color: VidColors.neutral200),
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                children: [
                  for (var i = 0; i < section.terms.length; i++)
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
                      decoration: BoxDecoration(
                        border: i == 0
                            ? null
                            : Border(top: BorderSide(color: VidColors.neutral100)),
                      ),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(
                            width: 170,
                            child: Text(
                              section.terms[i].term,
                              style: TextStyle(
                                color: VidColors.text,
                                fontWeight: FontWeight.w600,
                                fontSize: 13,
                              ),
                            ),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Text(
                              section.terms[i].def,
                              style: TextStyle(
                                color: VidColors.neutral600,
                                fontSize: 13,
                                height: 1.55,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
        if (section.note != null) ...[
          const SizedBox(height: 20),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 660),
            child: Container(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
              decoration: BoxDecoration(
                color: VidColors.primaryTint,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: VidColors.primary.withValues(alpha: 0.3)),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'NOTE',
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 1.0,
                      fontFamily: 'monospace',
                      color: VidColors.primaryHover,
                    ),
                  ),
                  const SizedBox(height: 5),
                  Text(
                    section.note!,
                    style: TextStyle(color: VidColors.text, fontSize: 13, height: 1.6),
                  ),
                ],
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// The explanatory diagrams. Only the ones that teach something the prose
/// can't are drawn — see the note at the top of constants/help_content.dart.
class HelpFigureView extends StatelessWidget {
  const HelpFigureView({super.key, required this.figure});

  final HelpFigure figure;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 660),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: VidColors.neutral100,
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: VidColors.neutral200),
        ),
        child: switch (figure) {
          HelpFigure.workflow => const _WorkflowFigure(),
          HelpFigure.metrics => const _MetricsFigure(),
          HelpFigure.spm => const _SpmFigure(),
          HelpFigure.dsm => const _DsmFigure(),
          HelpFigure.timeline => const _TimelineFigure(),
        },
      ),
    );
  }
}

class _WorkflowFigure extends StatelessWidget {
  const _WorkflowFigure();

  static const _steps = [
    'Create\nactions',
    'Train',
    'Process\nvideo',
    'Video\nlogs',
    'Analytics',
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            for (var i = 0; i < _steps.length; i++) ...[
              Expanded(
                child: Container(
                  height: 62,
                  decoration: BoxDecoration(
                    color: i < 2 ? VidColors.primaryTint : VidColors.surface,
                    borderRadius: BorderRadius.circular(9),
                    border: Border.all(
                      color: i < 2 ? VidColors.primary : VidColors.neutral200,
                    ),
                  ),
                  alignment: Alignment.center,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        '${i + 1}',
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                          color: VidColors.primary,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        _steps[i],
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 11.5,
                          fontWeight: FontWeight.w600,
                          color: VidColors.text,
                          height: 1.25,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              if (i < _steps.length - 1)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                  child: Icon(Icons.arrow_right_alt, size: 16, color: VidColors.neutral400),
                ),
            ],
          ],
        ),
        const SizedBox(height: 10),
        Row(
          children: [
            Text('Once per study',
                style: TextStyle(fontSize: 11, color: VidColors.neutral500)),
            const Spacer(),
            Text('Repeat for every new recording',
                style: TextStyle(fontSize: 11, color: VidColors.neutral500)),
          ],
        ),
      ],
    );
  }
}

class _MetricsFigure extends StatelessWidget {
  const _MetricsFigure();

  static const _rows = [
    ('CNN-only', '91.2%'),
    ('OCR text-only', '78.4%'),
    ('Combined', '96.4%'),
  ];
  static const _matrix = [
    [92, 4, 4],
    [6, 88, 6],
    [3, 9, 88],
  ];

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < _rows.length; i++)
                Container(
                  margin: const EdgeInsets.only(bottom: 6),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: i == 2 ? VidColors.primaryTint : VidColors.surface,
                    borderRadius: BorderRadius.circular(7),
                    border: Border.all(color: VidColors.neutral200),
                  ),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(_rows[i].$1,
                            style: TextStyle(fontSize: 12, color: VidColors.text)),
                      ),
                      Text(_rows[i].$2,
                          style: TextStyle(
                              fontSize: 12,
                              fontFamily: 'monospace',
                              color: VidColors.text)),
                    ],
                  ),
                ),
              const SizedBox(height: 2),
              Text('Combined is what actually runs',
                  style: TextStyle(fontSize: 11, color: VidColors.neutral500)),
            ],
          ),
        ),
        const SizedBox(width: 20),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Confusion matrix',
                style: TextStyle(fontSize: 11, color: VidColors.neutral500)),
            const SizedBox(height: 6),
            for (var r = 0; r < 3; r++)
              Row(
                children: [
                  for (var c = 0; c < 3; c++)
                    Container(
                      width: 40,
                      height: 28,
                      margin: const EdgeInsets.only(right: 3, bottom: 3),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: (r == c ? VidColors.success : VidColors.danger)
                            .withValues(alpha: r == c ? 0.16 + _matrix[r][c] / 260 : 0.06 + _matrix[r][c] / 130),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Text('${_matrix[r][c]}',
                          style: TextStyle(
                              fontSize: 11,
                              fontFamily: 'monospace',
                              color: VidColors.text)),
                    ),
                ],
              ),
            const SizedBox(height: 4),
            SizedBox(
              width: 132,
              child: Text('Diagonal = correct. Bright off-diagonal = a confused pair.',
                  style: TextStyle(fontSize: 10, color: VidColors.neutral500, height: 1.4)),
            ),
          ],
        ),
      ],
    );
  }
}

class _SpmFigure extends StatelessWidget {
  const _SpmFigure();

  static const _rows = [
    (['Login', 'Search'], '86%', '2.4'),
    (['Search', 'Checkout'], '71%', '1.8'),
    (['Search', 'Search'], '64%', '3.1'),
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Row(
          children: [
            Expanded(
                child: Text('Pattern',
                    style: TextStyle(fontSize: 11, color: VidColors.neutral500))),
            SizedBox(
                width: 74,
                child: Text('S-support',
                    textAlign: TextAlign.right,
                    style: TextStyle(fontSize: 11, color: VidColors.neutral500))),
            SizedBox(
                width: 68,
                child: Text('I-support',
                    textAlign: TextAlign.right,
                    style: TextStyle(fontSize: 11, color: VidColors.neutral500))),
          ],
        ),
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Divider(height: 1, color: VidColors.neutral200),
        ),
        for (final row in _rows)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Row(
              children: [
                Expanded(
                  child: Wrap(
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 4,
                    children: [
                      for (var i = 0; i < row.$1.length; i++) ...[
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(
                            color: VidColors.surface,
                            borderRadius: BorderRadius.circular(6),
                            border: Border.all(color: VidColors.neutral200),
                          ),
                          child: Text(row.$1[i],
                              style: TextStyle(fontSize: 11, color: VidColors.text)),
                        ),
                        if (i < row.$1.length - 1)
                          Icon(Icons.arrow_right_alt,
                              size: 13, color: VidColors.neutral400),
                      ],
                    ],
                  ),
                ),
                SizedBox(
                    width: 74,
                    child: Text(row.$2,
                        textAlign: TextAlign.right,
                        style: TextStyle(fontSize: 11.5, color: VidColors.text))),
                SizedBox(
                    width: 68,
                    child: Text(row.$3,
                        textAlign: TextAlign.right,
                        style: TextStyle(fontSize: 11.5, color: VidColors.text))),
              ],
            ),
          ),
      ],
    );
  }
}

class _DsmFigure extends StatelessWidget {
  const _DsmFigure();

  @override
  Widget build(BuildContext context) {
    Widget group(String name, bool tinted) => Expanded(
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: tinted ? VidColors.primaryTint : VidColors.surface,
              borderRadius: BorderRadius.circular(9),
              border: Border.all(color: VidColors.neutral200),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name,
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: VidColors.text)),
                const SizedBox(height: 8),
                for (var i = 0; i < 3; i++)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 5),
                    child: Row(
                      children: [
                        Icon(
                          i < 2 ? Icons.check_box : Icons.check_box_outline_blank,
                          size: 14,
                          color: i < 2 ? VidColors.primary : VidColors.neutral400,
                        ),
                        const SizedBox(width: 7),
                        Container(
                          width: 96,
                          height: 5,
                          decoration: BoxDecoration(
                            color: VidColors.neutral300,
                            borderRadius: BorderRadius.circular(3),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        );

    return Column(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            group('Group A', true),
            const SizedBox(width: 14),
            group('Group B', false),
          ],
        ),
        const SizedBox(height: 10),
        Text('A log may belong to one group only; the other list disables it',
            style: TextStyle(fontSize: 11, color: VidColors.neutral500)),
      ],
    );
  }
}

class _TimelineFigure extends StatelessWidget {
  const _TimelineFigure();

  // (flex, colour index) — flex rather than pixels so the bars fill whatever
  // width the window happens to give them.
  static const _bars = [
    (3, 0),
    (5, 1),
    (2, 2),
    (2, 0),
    (3, 1),
  ];

  @override
  Widget build(BuildContext context) {
    final colors = [VidColors.primary, VidColors.secondary, VidColors.warning];
    Widget track(String label, double opacity) => Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Row(
            children: [
              SizedBox(
                width: 74,
                child: Text(label,
                    style: TextStyle(fontSize: 11, color: VidColors.neutral500)),
              ),
              Expanded(
                child: Row(
                  children: [
                    for (final (flex, tone) in _bars) ...[
                      Expanded(
                        flex: flex,
                        child: Container(
                          height: 18,
                          decoration: BoxDecoration(
                            color: colors[tone].withValues(alpha: opacity),
                            borderRadius: BorderRadius.circular(3),
                          ),
                        ),
                      ),
                      const SizedBox(width: 3),
                    ],
                  ],
                ),
              ),
            ],
          ),
        );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        track('session-01', 0.8),
        track('session-02', 0.55),
        Divider(height: 12, color: VidColors.neutral200),
        Row(
          children: [
            Text('0:00', style: TextStyle(fontSize: 10, color: VidColors.neutral500)),
            const Spacer(),
            Text('end', style: TextStyle(fontSize: 10, color: VidColors.neutral500)),
          ],
        ),
      ],
    );
  }
}
