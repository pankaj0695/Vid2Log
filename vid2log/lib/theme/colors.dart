/// Design tokens ported 1:1 from the web app's dark AND light themes
/// (frontend/app/globals.css `:root` and `[data-theme="light"]` blocks,
/// that file's the source of truth; keep these in sync with it by hand if
/// it ever changes).
///
/// [VidColors] fields are getters, not `static const` values, so that every
/// existing call site (`VidColors.text`, `VidColors.bg`, ...) keeps working
/// unchanged while resolving to whichever palette [VidTheme.brightness]
/// currently holds. Toggling [VidTheme.toggle] therefore re-themes the
/// entire app without every widget needing to know a theme even exists.
library;

import 'package:flutter/material.dart';

/// Tracks which palette [VidColors] resolves against. A bare
/// [ValueNotifier] (not a full state-management dependency) is deliberate,
/// this is the app's only piece of cross-cutting UI state. main.dart wraps
/// the whole [MaterialApp] in a `ValueListenableBuilder` listening to this,
/// so flipping it rebuilds every screen with the new colors.
class VidTheme {
  VidTheme._();

  static final ValueNotifier<Brightness> brightness = ValueNotifier(Brightness.dark);

  static bool get isLight => brightness.value == Brightness.light;

  static void toggle() {
    brightness.value = isLight ? Brightness.dark : Brightness.light;
  }
}

class _Palette {
  const _Palette({
    required this.bg,
    required this.surface,
    required this.surface2,
    required this.text,
    required this.ink,
    required this.primary,
    required this.primaryHover,
    required this.primaryTint,
    required this.secondary,
    required this.secondaryHover,
    required this.secondaryTint,
    required this.success,
    required this.successTint,
    required this.warning,
    required this.warningTint,
    required this.danger,
    required this.dangerTint,
    required this.neutral50,
    required this.neutral100,
    required this.neutral200,
    required this.neutral300,
    required this.neutral400,
    required this.neutral500,
    required this.neutral600,
    required this.neutral700,
    required this.neutral800,
    required this.neutral900,
  });

  final Color bg;
  final Color surface;
  final Color surface2;
  final Color text;
  final Color ink;
  final Color primary;
  final Color primaryHover;
  final Color primaryTint;
  final Color secondary;
  final Color secondaryHover;
  final Color secondaryTint;
  final Color success;
  final Color successTint;
  final Color warning;
  final Color warningTint;
  final Color danger;
  final Color dangerTint;
  final Color neutral50;
  final Color neutral100;
  final Color neutral200;
  final Color neutral300;
  final Color neutral400;
  final Color neutral500;
  final Color neutral600;
  final Color neutral700;
  final Color neutral800;
  final Color neutral900;
}

const _dark = _Palette(
  bg: Color(0xFF070C13),
  surface: Color(0xFF0E1720),
  surface2: Color(0xFF142030),
  text: Color(0xFFEEF4F8),
  ink: Color(0xFF071310),
  primary: Color(0xFF2DD4BF),
  primaryHover: Color(0xFF5EEAD4),
  primaryTint: Color(0xFF0E2B27),
  secondary: Color(0xFF38BDF8),
  secondaryHover: Color(0xFF7DD3FC),
  secondaryTint: Color(0xFF0D2432),
  success: Color(0xFF34D399),
  successTint: Color(0xFF0F2A20),
  warning: Color(0xFFFBBF24),
  warningTint: Color(0xFF2C2410),
  danger: Color(0xFFF87171),
  dangerTint: Color(0xFF2C1315),
  neutral50: Color(0xFF0B131C),
  neutral100: Color(0xFF101B26),
  neutral200: Color(0xFF1B2733),
  neutral300: Color(0xFF293A4B),
  neutral400: Color(0xFF48627A),
  neutral500: Color(0xFF7D93A8),
  neutral600: Color(0xFF9DB0C2),
  neutral700: Color(0xFFC1CEDB),
  neutral800: Color(0xFFDDE5EB),
  neutral900: Color(0xFFF3F7FA),
);

// Ported from frontend/app/globals.css's [data-theme="light"] block. Note
// the accent colors are deepened (not the same bright hues re-used), a
// bright #2dd4bf teal works as a BACKGROUND fill on near-black, but fails
// contrast as text/icon color on a light page, and needs light ink text
// instead of dark ink as a button fill. `ink` itself flips (near-black in
// dark mode, near-white in light mode) to match.
const _light = _Palette(
  bg: Color(0xFFF8FAFC),
  surface: Color(0xFFFFFFFF),
  surface2: Color(0xFFEEF2F6),
  text: Color(0xFF0F172A),
  ink: Color(0xFFFFFFFF),
  primary: Color(0xFF0D9488),
  primaryHover: Color(0xFF0F766E),
  primaryTint: Color(0xFFECFDF5),
  secondary: Color(0xFF0284C7),
  secondaryHover: Color(0xFF0369A1),
  secondaryTint: Color(0xFFEFF8FF),
  success: Color(0xFF059669),
  successTint: Color(0xFFECFDF5),
  warning: Color(0xFFD97706),
  warningTint: Color(0xFFFFFBEB),
  danger: Color(0xFFDC2626),
  dangerTint: Color(0xFFFEF2F2),
  neutral50: Color(0xFFF8FAFC),
  neutral100: Color(0xFFEEF2F6),
  neutral200: Color(0xFFE2E8F0),
  neutral300: Color(0xFFCBD5E1),
  neutral400: Color(0xFF94A3B8),
  neutral500: Color(0xFF64748B),
  neutral600: Color(0xFF475569),
  neutral700: Color(0xFF334155),
  neutral800: Color(0xFF1E293B),
  neutral900: Color(0xFF0F172A),
);

class VidColors {
  VidColors._();

  static _Palette get _p => VidTheme.isLight ? _light : _dark;

  static Color get bg => _p.bg;
  static Color get surface => _p.surface;
  static Color get surface2 => _p.surface2;
  static Color get text => _p.text;
  static Color get ink => _p.ink;

  static Color get primary => _p.primary;
  static Color get primaryHover => _p.primaryHover;
  static Color get primaryTint => _p.primaryTint;

  static Color get secondary => _p.secondary;
  static Color get secondaryHover => _p.secondaryHover;
  static Color get secondaryTint => _p.secondaryTint;

  static Color get success => _p.success;
  static Color get successTint => _p.successTint;

  static Color get warning => _p.warning;
  static Color get warningTint => _p.warningTint;

  static Color get danger => _p.danger;
  static Color get dangerTint => _p.dangerTint;

  static Color get neutral50 => _p.neutral50;
  static Color get neutral100 => _p.neutral100;
  static Color get neutral200 => _p.neutral200;
  static Color get neutral300 => _p.neutral300;
  static Color get neutral400 => _p.neutral400;
  static Color get neutral500 => _p.neutral500;
  static Color get neutral600 => _p.neutral600;
  static Color get neutral700 => _p.neutral700;
  static Color get neutral800 => _p.neutral800;
  static Color get neutral900 => _p.neutral900;
}
