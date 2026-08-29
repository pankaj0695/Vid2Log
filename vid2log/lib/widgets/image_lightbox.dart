/// Full-screen image viewer, ported from
/// frontend/components/ui/ImageLightbox.tsx — click a thumbnail to open it
/// large, then step through the rest of that action's images with the arrow
/// buttons or the ← → keys, and Esc to close.
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/colors.dart';

Future<void> showImageLightbox(
  BuildContext context, {
  required List<String> imagePaths,
  required int initialIndex,
}) {
  if (imagePaths.isEmpty) return Future.value();
  return showDialog(
    context: context,
    barrierColor: Colors.black87,
    builder: (_) => _Lightbox(imagePaths: imagePaths, initialIndex: initialIndex),
  );
}

class _Lightbox extends StatefulWidget {
  const _Lightbox({required this.imagePaths, required this.initialIndex});

  final List<String> imagePaths;
  final int initialIndex;

  @override
  State<_Lightbox> createState() => _LightboxState();
}

class _LightboxState extends State<_Lightbox> {
  late int _index = widget.initialIndex.clamp(0, widget.imagePaths.length - 1);
  final _focusNode = FocusNode();

  @override
  void initState() {
    super.initState();
    // Requested after the first frame so the dialog's own route transition
    // has finished taking focus, otherwise the key handler never fires.
    WidgetsBinding.instance.addPostFrameCallback((_) => _focusNode.requestFocus());
  }

  @override
  void dispose() {
    _focusNode.dispose();
    super.dispose();
  }

  void _step(int delta) {
    setState(() {
      _index = (_index + delta) % widget.imagePaths.length;
      if (_index < 0) _index += widget.imagePaths.length;
    });
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;
    if (event.logicalKey == LogicalKeyboardKey.arrowLeft) {
      _step(-1);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowRight) {
      _step(1);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.escape) {
      Navigator.of(context).pop();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final multiple = widget.imagePaths.length > 1;

    return Focus(
      focusNode: _focusNode,
      onKeyEvent: _onKey,
      child: Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.all(40),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                if (multiple)
                  Text(
                    '${_index + 1} / ${widget.imagePaths.length}',
                    style: const TextStyle(color: Colors.white70, fontSize: 13),
                  ),
                const Spacer(),
                IconButton(
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close, color: Colors.white),
                  tooltip: 'Close (Esc)',
                ),
              ],
            ),
            Flexible(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (multiple)
                    IconButton(
                      onPressed: () => _step(-1),
                      icon: const Icon(Icons.chevron_left, color: Colors.white, size: 32),
                      tooltip: 'Previous (←)',
                    ),
                  Flexible(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(10),
                      child: Image.file(
                        File(widget.imagePaths[_index]),
                        fit: BoxFit.contain,
                        errorBuilder: (_, __, ___) => Container(
                          width: 320,
                          height: 200,
                          color: VidColors.neutral100,
                          alignment: Alignment.center,
                          child: const Text(
                            'This image is no longer on disk.',
                            style: TextStyle(color: VidColors.neutral500),
                          ),
                        ),
                      ),
                    ),
                  ),
                  if (multiple)
                    IconButton(
                      onPressed: () => _step(1),
                      icon: const Icon(Icons.chevron_right, color: Colors.white, size: 32),
                      tooltip: 'Next (→)',
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
