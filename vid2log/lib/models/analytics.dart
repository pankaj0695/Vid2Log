/// Data models for the Analytics section, mirroring the sidecar's
/// SPM/DSM schemas (python_sidecar/app/schemas.py).
library;

/// Options shared by both mining tabs, the "Advanced options" panel.
/// Defaults match python_sidecar/app/schemas.py's own defaults, which in
/// turn reproduce plain unconstrained PrefixSpan apart from maxGap.
class MiningOptions {
  const MiningOptions({
    this.minSupport = 0.4,
    this.topK = 10,
    this.slidingWindowMin = 1,
    this.slidingWindowMax = 4,
    this.minGap = 0,
    this.maxGap = 12,
    this.minInstanceSupport = 0.0,
  });

  /// S-support threshold: the fraction of logs a pattern must appear in.
  final double minSupport;
  final int topK;

  /// Shortest / longest pattern length considered.
  final int slidingWindowMin;
  final int slidingWindowMax;

  /// How many other events may sit between two consecutive pattern items.
  /// A null [maxGap] means unlimited (plain PrefixSpan matching).
  final int minGap;
  final int? maxGap;

  /// I-support threshold: minimum mean instances per log.
  final double minInstanceSupport;

  Map<String, dynamic> toJson() => {
        'min_support': minSupport,
        'top_k': topK,
        'sliding_window_min': slidingWindowMin,
        'sliding_window_max': slidingWindowMax,
        'min_gap': minGap,
        'max_gap': maxGap,
        'min_instance_support': minInstanceSupport,
      };
}

class SpmPattern {
  const SpmPattern({
    required this.pattern,
    required this.support,
    required this.supportFraction,
    required this.iFrequency,
    required this.iSupportMean,
    required this.iSupportSd,
  });

  final List<String> pattern;

  /// S-frequency, how many logs contain this pattern at least once.
  final int support;

  /// S-support, [support] as a fraction of the logs analysed.
  final double supportFraction;

  /// Total non-overlapping occurrences across every log.
  final int iFrequency;

  /// I-support: mean occurrences per log, with zero-occurrence logs
  /// included in the average.
  final double iSupportMean;
  final double iSupportSd;

  factory SpmPattern.fromJson(Map<String, dynamic> json) => SpmPattern(
        pattern: (json['pattern'] as List<dynamic>).map((e) => e as String).toList(),
        support: json['support'] as int,
        supportFraction: (json['support_fraction'] as num).toDouble(),
        iFrequency: json['i_frequency'] as int,
        iSupportMean: (json['i_support_mean'] as num).toDouble(),
        iSupportSd: (json['i_support_sd'] as num).toDouble(),
      );
}

class DsmPattern {
  const DsmPattern({
    required this.pattern,
    required this.pValue,
    this.isupportLeftMean,
    this.isupportRightMean,
    required this.group,
  });

  final List<String> pattern;
  final double pValue;

  /// Only one of these is populated per row, whichever group the pattern
  /// is characteristic of. See the sidecar's dsm_analyze for why a pattern
  /// frequent in both groups produces two rows rather than one.
  final double? isupportLeftMean;
  final double? isupportRightMean;

  /// "left" (group A) or "right" (group B).
  final String group;

  factory DsmPattern.fromJson(Map<String, dynamic> json) => DsmPattern(
        pattern: (json['pattern'] as List<dynamic>).map((e) => e as String).toList(),
        pValue: (json['p_value'] as num).toDouble(),
        isupportLeftMean: (json['isupport_left_mean'] as num?)?.toDouble(),
        isupportRightMean: (json['isupport_right_mean'] as num?)?.toDouble(),
        group: json['group'] as String,
      );
}
