/// Lets the `?` button in any screen's PageHeader jump to the matching
/// section of the Help screen.
///
/// The web app does this with a URL fragment (`/help#process`). There are no
/// URLs here, so the shell exposes a callback through the widget tree
/// instead. An InheritedWidget rather than a constructor parameter because
/// PageHeader is used by every screen, and threading an `onHelp` callback
/// down through all of them — most of which take no navigation callbacks at
/// all today — would mean touching every screen's constructor to deliver
/// something none of them care about.
library;

import 'package:flutter/widgets.dart';

class HelpNavigator extends InheritedWidget {
  const HelpNavigator({super.key, required this.openHelp, required super.child});

  /// Switches to the Help screen and scrolls to [sectionId] (an id from
  /// constants/help_content.dart).
  final void Function(String sectionId) openHelp;

  static HelpNavigator? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<HelpNavigator>();

  // The callback identity is stable for the life of the shell, so nothing
  // downstream ever needs to rebuild on account of this widget.
  @override
  bool updateShouldNotify(HelpNavigator oldWidget) => false;
}
