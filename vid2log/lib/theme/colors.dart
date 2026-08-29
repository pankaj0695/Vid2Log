/// Design tokens ported 1:1 from the web app's dark theme
/// (frontend/app/globals.css `:root` block — that file's the source of
/// truth; keep these in sync with it by hand if it ever changes). Only the
/// dark palette is ported for this first pass — the web app also has a
/// light theme + toggle (see ThemeToggle.tsx there), not included here yet.
library;

import 'package:flutter/material.dart';

class VidColors {
  VidColors._();

  static const bg = Color(0xFF070C13);
  static const surface = Color(0xFF0E1720);
  static const surface2 = Color(0xFF142030);
  static const text = Color(0xFFEEF4F8);
  static const ink = Color(0xFF071310);

  static const primary = Color(0xFF2DD4BF);
  static const primaryHover = Color(0xFF5EEAD4);
  static const primaryTint = Color(0xFF0E2B27);

  static const secondary = Color(0xFF38BDF8);
  static const secondaryHover = Color(0xFF7DD3FC);
  static const secondaryTint = Color(0xFF0D2432);

  static const success = Color(0xFF34D399);
  static const successTint = Color(0xFF0F2A20);

  static const warning = Color(0xFFFBBF24);
  static const warningTint = Color(0xFF2C2410);

  static const danger = Color(0xFFF87171);
  static const dangerTint = Color(0xFF2C1315);

  static const neutral50 = Color(0xFF0B131C);
  static const neutral100 = Color(0xFF101B26);
  static const neutral200 = Color(0xFF1B2733);
  static const neutral300 = Color(0xFF293A4B);
  static const neutral400 = Color(0xFF48627A);
  static const neutral500 = Color(0xFF7D93A8);
  static const neutral600 = Color(0xFF9DB0C2);
  static const neutral700 = Color(0xFFC1CEDB);
  static const neutral800 = Color(0xFFDDE5EB);
  static const neutral900 = Color(0xFFF3F7FA);
}
