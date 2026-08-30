library;

import 'package:flutter/material.dart';

import 'colors.dart';

ThemeData buildAppTheme() {
  final brightness = VidTheme.brightness.value;
  final base = ThemeData(
    useMaterial3: true,
    brightness: brightness,
  );

  return base.copyWith(
    scaffoldBackgroundColor: VidColors.bg,
    canvasColor: VidColors.bg,
    cardColor: VidColors.surface,
    dividerColor: VidColors.neutral200,
    splashFactory: InkRipple.splashFactory,
    colorScheme: base.colorScheme.copyWith(
      brightness: brightness,
      primary: VidColors.primary,
      onPrimary: VidColors.ink,
      secondary: VidColors.secondary,
      onSecondary: VidColors.ink,
      surface: VidColors.surface,
      onSurface: VidColors.text,
      error: VidColors.danger,
      onError: VidColors.ink,
      outline: VidColors.neutral200,
    ),
    textTheme: base.textTheme
        .apply(
          bodyColor: VidColors.text,
          displayColor: VidColors.text,
        )
        .copyWith(
          headlineMedium: TextStyle(
            fontSize: 32,
            fontWeight: FontWeight.w700,
            color: VidColors.text,
            letterSpacing: -0.2,
          ),
          titleLarge: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: VidColors.text,
          ),
          bodyMedium: TextStyle(
            fontSize: 14,
            color: VidColors.text,
          ),
          bodySmall: TextStyle(
            fontSize: 13,
            color: VidColors.neutral500,
          ),
        ),
    appBarTheme: AppBarTheme(
      backgroundColor: VidColors.surface,
      foregroundColor: VidColors.text,
      elevation: 0,
      surfaceTintColor: Colors.transparent,
    ),
    cardTheme: CardThemeData(
      color: VidColors.surface,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(12),
        side: BorderSide(color: VidColors.neutral200),
      ),
    ),
    dialogTheme: DialogThemeData(
      backgroundColor: VidColors.surface,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: VidColors.neutral100,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: VidColors.neutral200),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: VidColors.neutral200),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: BorderSide(color: VidColors.primary),
      ),
      hintStyle: TextStyle(color: VidColors.neutral500),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: VidColors.primary,
        foregroundColor: VidColors.ink,
        textStyle: const TextStyle(fontWeight: FontWeight.w600),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: VidColors.text,
        side: BorderSide(color: VidColors.neutral300),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(
        foregroundColor: VidColors.primary,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    ),
    iconTheme: IconThemeData(color: VidColors.neutral500),
    dataTableTheme: DataTableThemeData(
      headingTextStyle: TextStyle(
        color: VidColors.neutral500,
        fontWeight: FontWeight.w600,
        fontSize: 13,
      ),
      dataTextStyle: TextStyle(color: VidColors.text, fontSize: 13),
      dividerThickness: 1,
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(
      color: VidColors.primary,
    ),
    sliderTheme: SliderThemeData(
      activeTrackColor: VidColors.primary,
      thumbColor: VidColors.primary,
      inactiveTrackColor: VidColors.neutral200,
    ),
  );
}
