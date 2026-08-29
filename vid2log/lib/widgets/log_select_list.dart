/// Ported from frontend/components/analytics/JobSelectList.tsx — the
/// checkbox list of finished logs that all four Analytics tabs share, with
/// shift-click range selection and select-all/none.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/job.dart';
import '../theme/colors.dart';

class LogSelectList extends StatefulWidget {
  const LogSelectList({
    super.key,
    required this.jobs,
    required this.selected,
    required this.onChanged,
    this.label = 'Select logs',
    this.height = 220,
    this.disabled = const {},
    this.disabledHint,
  });

  final List<Job> jobs;
  final Set<String> selected;
  final ValueChanged<Set<String>> onChanged;
  final String label;
  final double height;

  /// Logs that can't be picked here — used by DSM, where a log already in
  /// one group must not be selectable in the other. Blocking it at the
  /// point of selection is clearer than letting it be chosen and then
  /// rejecting the whole run afterwards.
  final Set<String> disabled;

  /// Tooltip explaining why a disabled row is disabled.
  final String? disabledHint;

  @override
  State<LogSelectList> createState() => _LogSelectListState();
}

class _LogSelectListState extends State<LogSelectList> {
  /// Anchor for shift-click range selection — the last row clicked without
  /// shift held.
  int? _anchorIndex;

  void _toggle(int index, {required bool shiftHeld}) {
    if (widget.disabled.contains(widget.jobs[index].jobId)) return;

    final next = {...widget.selected};
    final anchor = _anchorIndex;

    if (shiftHeld && anchor != null && anchor != index) {
      // Range select: everything between the anchor and here takes the
      // anchor row's resulting state, which is what makes shift-click feel
      // like a file manager rather than toggling each row independently.
      final start = anchor < index ? anchor : index;
      final end = anchor < index ? index : anchor;
      final selecting = !widget.selected.contains(widget.jobs[index].jobId);
      for (var i = start; i <= end; i++) {
        final id = widget.jobs[i].jobId;
        if (widget.disabled.contains(id)) continue;
        if (selecting) {
          next.add(id);
        } else {
          next.remove(id);
        }
      }
    } else {
      final id = widget.jobs[index].jobId;
      if (next.contains(id)) {
        next.remove(id);
      } else {
        next.add(id);
      }
      _anchorIndex = index;
    }

    widget.onChanged(next);
  }

  bool get _shiftHeld =>
      HardwareKeyboard.instance.logicalKeysPressed.contains(LogicalKeyboardKey.shiftLeft) ||
      HardwareKeyboard.instance.logicalKeysPressed.contains(LogicalKeyboardKey.shiftRight);

  @override
  Widget build(BuildContext context) {
    final allSelected =
        widget.jobs.isNotEmpty && widget.selected.length == widget.jobs.length;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              widget.label,
              style: const TextStyle(
                  color: VidColors.neutral500, fontSize: 13, fontWeight: FontWeight.w500),
            ),
            const SizedBox(width: 8),
            Text(
              '${widget.selected.length} selected',
              style: const TextStyle(color: VidColors.neutral400, fontSize: 12),
            ),
            const Spacer(),
            TextButton(
              onPressed: widget.jobs.isEmpty
                  ? null
                  : () => widget.onChanged(
                        allSelected ? <String>{} : widget.jobs.map((j) => j.jobId).toSet(),
                      ),
              child: Text(allSelected ? 'Clear' : 'Select all'),
            ),
          ],
        ),
        const SizedBox(height: 6),
        Container(
          height: widget.height,
          decoration: BoxDecoration(
            color: VidColors.neutral100,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: VidColors.neutral200),
          ),
          child: widget.jobs.isEmpty
              ? const Center(
                  child: Text(
                    'No finished logs yet.',
                    style: TextStyle(color: VidColors.neutral500, fontSize: 13),
                  ),
                )
              : ListView.builder(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  itemCount: widget.jobs.length,
                  itemBuilder: (context, i) {
                    final job = widget.jobs[i];
                    final checked = widget.selected.contains(job.jobId);
                    final isDisabled = widget.disabled.contains(job.jobId);

                    final row = Opacity(
                      opacity: isDisabled ? 0.4 : 1,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                        child: Row(
                          children: [
                            SizedBox(
                              width: 32,
                              child: Checkbox(
                                value: checked,
                                onChanged: isDisabled
                                    ? null
                                    : (_) => _toggle(i, shiftHeld: _shiftHeld),
                              ),
                            ),
                            Expanded(
                              child: Text(
                                job.label,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: checked ? VidColors.text : VidColors.neutral600,
                                  fontSize: 13,
                                ),
                              ),
                            ),
                            Text(
                              '${job.sceneCount ?? 0}',
                              style: const TextStyle(
                                  color: VidColors.neutral500, fontSize: 12, fontFamily: 'monospace'),
                            ),
                          ],
                        ),
                      ),
                    );

                    if (isDisabled) {
                      return Tooltip(
                        message: widget.disabledHint ?? 'Not available here',
                        child: row,
                      );
                    }
                    return InkWell(
                      onTap: () => _toggle(i, shiftHeld: _shiftHeld),
                      child: row,
                    );
                  },
                ),
        ),
        const SizedBox(height: 4),
        const Text(
          'Shift-click to select a range.',
          style: TextStyle(color: VidColors.neutral400, fontSize: 11),
        ),
      ],
    );
  }
}
