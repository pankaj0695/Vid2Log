/// Data models mirroring the sidecar's training/model schemas
/// (python_sidecar/app/schemas.py: ScannedAction, TrainingJobOut, ModelOut).
library;

import 'job.dart' show JobStatus, jobStatusFromString;

/// Must match python_sidecar/app/main.py's DEFAULT_MODEL_ID, the sentinel
/// id for the CNN bundled inside the app, which has no registry row.
const kDefaultModelId = '__default__';

/// One action subfolder found by POST /train/scan-folder.
class ScannedAction {
  const ScannedAction({
    required this.name,
    required this.imageCount,
    required this.imagePaths,
  });

  final String name;
  final int imageCount;
  final List<String> imagePaths;

  factory ScannedAction.fromJson(Map<String, dynamic> json) => ScannedAction(
        name: json['name'] as String,
        imageCount: json['image_count'] as int,
        imagePaths:
            (json['image_paths'] as List<dynamic>).map((e) => e as String).toList(),
      );

  ScannedAction copyWith({String? name, List<String>? imagePaths}) => ScannedAction(
        name: name ?? this.name,
        imagePaths: imagePaths ?? this.imagePaths,
        imageCount: (imagePaths ?? this.imagePaths).length,
      );
}

/// Free-form progress payload the training pipeline reports per stage
/// (see training_pipeline.py's `_progress` calls).
class TrainingProgress {
  const TrainingProgress(this.raw);

  final Map<String, dynamic> raw;

  String get stage => raw['stage'] as String? ?? '';
  String? get detail => raw['detail'] as String?;
  int? get epoch => raw['epoch'] as int?;
  int? get epochs => raw['epochs'] as int?;
  double? get accuracy => (raw['accuracy'] as num?)?.toDouble();
  double? get valAccuracy => (raw['val_accuracy'] as num?)?.toDouble();
  double? get loss => (raw['loss'] as num?)?.toDouble();

  /// Overall 0..1 completion estimate across the WHOLE job, not just
  /// however far the current stage itself has gotten, so the UI can show a
  /// single steadily-advancing bar and percentage instead of a bare
  /// spinner. Neither pipeline reports a numeric percent for most stages,
  /// but the stages always run in the same fixed order (see
  /// action_discovery.py / training_pipeline.py), so mapping each one to a
  /// fixed checkpoint (see [_kStageCheckpoints]) still gives real forward
  /// motion, it just jumps between known checkpoints for stages with no
  /// finer signal.
  ///
  /// `training_cnn` is the one stage with a real, continuously-advancing
  /// signal (epoch out of total epochs), so it's interpolated between the
  /// checkpoint just before it and its own rather than only jumping to its
  /// checkpoint the instant training starts.
  ///
  /// Null only for a stage this app doesn't recognise, in which case the
  /// UI falls back to an indeterminate (percentage-less) progress bar.
  double? get overallFraction {
    final checkpoint = _kStageCheckpoints[stage];
    if (checkpoint == null) return null;

    if (stage == 'training_cnn' && epoch != null && epochs != null && epochs! > 0) {
      final i = _kTrainingStageOrder.indexOf('training_cnn');
      final previousCheckpoint =
          i > 0 ? (_kStageCheckpoints[_kTrainingStageOrder[i - 1]] ?? 0.0) : 0.0;
      final epochFraction = (epoch! / epochs!).clamp(0.0, 1.0);
      return previousCheckpoint + (checkpoint - previousCheckpoint) * epochFraction;
    }
    return checkpoint;
  }

  String get label {
    switch (stage) {
      case 'starting':
        return 'Starting…';
      case 'preparing':
        return detail ?? 'Preparing dataset…';
      case 'training_cnn':
        final e = epoch, total = epochs;
        if (e != null && total != null) return 'Training, epoch $e of $total';
        return 'Training…';
      case 'evaluating_cnn':
        return 'Evaluating on the test split…';
      case 'extracting_text':
        return detail ?? 'Running OCR…';
      case 'tuning_fusion':
        return detail ?? 'Tuning CNN/text fusion…';
      case 'saving_model':
        return detail ?? 'Saving model…';
      // Action discovery stages (see app/action_discovery.py).
      case 'sampling':
        return detail ?? 'Sampling frames…';
      case 'embedding':
        return detail ?? 'Analysing frames…';
      case 'clustering':
        return detail ?? 'Grouping similar screens…';
      case 'writing_previews':
        return detail ?? 'Preparing previews…';
      default:
        return detail ?? 'Working…';
    }
  }
}

/// Fixed checkpoint reached at the END of each stage, in run order, shared
/// by both pipelines since a given job only ever reports stages from one
/// of them. Values are hand-tuned relative weights (training's CNN epoch
/// loop and the OCR/fusion stages typically dominate total run time far
/// more than, say, "starting"), not measured averages.
const Map<String, double> _kStageCheckpoints = {
  'starting': 0.04,
  // Action discovery pipeline (action_discovery.py).
  'sampling': 0.28,
  'embedding': 0.58,
  'clustering': 0.8,
  'writing_previews': 0.93,
  // Training pipeline (training_pipeline.py).
  'preparing': 0.1,
  'training_cnn': 0.75,
  'evaluating_cnn': 0.82,
  'extracting_text': 0.88,
  'tuning_fusion': 0.94,
  'saving_model': 0.98,
};

/// Training stage keys in run order, used only to find the checkpoint
/// immediately BEFORE `training_cnn` so its real epoch progress can be
/// interpolated between two checkpoints instead of jumping straight to its
/// own the instant training starts.
const List<String> _kTrainingStageOrder = [
  'starting',
  'preparing',
  'training_cnn',
  'evaluating_cnn',
  'extracting_text',
  'tuning_fusion',
  'saving_model',
];

/// Per-class precision/recall/F1/support from a metrics report.
class ClassMetrics {
  const ClassMetrics({
    required this.precision,
    required this.recall,
    required this.f1,
    required this.support,
  });

  final double precision;
  final double recall;
  final double f1;
  final int support;

  factory ClassMetrics.fromJson(Map<String, dynamic> json) => ClassMetrics(
        precision: (json['precision'] as num).toDouble(),
        recall: (json['recall'] as num).toDouble(),
        f1: (json['f1'] as num).toDouble(),
        support: json['support'] as int,
      );
}

/// One evaluation report, the sidecar produces three of these per model
/// (CNN-only, text-only, and the fused combination).
class EvalReport {
  const EvalReport({
    required this.accuracy,
    required this.perClass,
    required this.confusionMatrix,
    required this.testSetSize,
  });

  final double accuracy;
  final Map<String, ClassMetrics> perClass;
  final List<List<int>> confusionMatrix;
  final int testSetSize;

  factory EvalReport.fromJson(Map<String, dynamic> json) => EvalReport(
        accuracy: (json['accuracy'] as num).toDouble(),
        perClass: (json['per_class'] as Map<String, dynamic>).map(
          (k, v) => MapEntry(k, ClassMetrics.fromJson(v as Map<String, dynamic>)),
        ),
        confusionMatrix: (json['confusion_matrix'] as List<dynamic>)
            .map((row) => (row as List<dynamic>).map((e) => e as int).toList())
            .toList(),
        testSetSize: json['test_set_size'] as int,
      );
}

class ModelMetrics {
  const ModelMetrics({
    this.cnnOnly,
    this.textOnly,
    this.combined,
    this.fusionAlpha,
    this.fusionAlphaPerClass,
  });

  /// Always present for a trained model.
  final EvalReport? cnnOnly;

  /// Null when the dataset didn't have enough usable OCR text to train a
  /// text classifier at all, the CNN result stands on its own then.
  final EvalReport? textOnly;
  final EvalReport? combined;

  final double? fusionAlpha;
  final Map<String, double>? fusionAlphaPerClass;

  factory ModelMetrics.fromJson(Map<String, dynamic> json) {
    EvalReport? parse(String key) {
      final v = json[key];
      return v == null ? null : EvalReport.fromJson(v as Map<String, dynamic>);
    }

    final alphaPerClass = json['fusion_alpha_per_class'] as Map<String, dynamic>?;
    return ModelMetrics(
      cnnOnly: parse('cnn_only'),
      textOnly: parse('text_only'),
      combined: parse('combined'),
      fusionAlpha: (json['fusion_alpha'] as num?)?.toDouble(),
      fusionAlphaPerClass:
          alphaPerClass?.map((k, v) => MapEntry(k, (v as num).toDouble())),
    );
  }

  /// The report that reflects what the model will actually do at inference:
  /// the fused one when fusion is in play, otherwise CNN-only.
  EvalReport? get headline => combined ?? cnnOnly;
}

class TrainingJob {
  const TrainingJob({
    required this.trainingJobId,
    required this.status,
    required this.modelName,
    required this.dataset,
    required this.epochs,
    required this.batchSize,
    required this.learningRate,
    this.progress,
    this.modelId,
    this.metrics,
    this.error,
    required this.createdAt,
    this.startedAt,
    this.completedAt,
  });

  final String trainingJobId;
  final JobStatus status;
  final String modelName;
  final Map<String, List<String>> dataset;
  final int epochs;
  final int batchSize;
  final double learningRate;
  final TrainingProgress? progress;
  final String? modelId;
  final ModelMetrics? metrics;
  final String? error;
  final String createdAt;
  final String? startedAt;
  final String? completedAt;

  int get actionCount => dataset.length;
  int get imageCount => dataset.values.fold(0, (sum, v) => sum + v.length);

  factory TrainingJob.fromJson(Map<String, dynamic> json) {
    final ds = (json['dataset'] as Map<String, dynamic>).map(
      (k, v) => MapEntry(k, (v as List<dynamic>).map((e) => e as String).toList()),
    );
    final prog = json['progress'] as Map<String, dynamic>?;
    final metrics = json['metrics'] as Map<String, dynamic>?;
    return TrainingJob(
      trainingJobId: json['training_job_id'] as String,
      status: jobStatusFromString(json['status'] as String),
      modelName: json['model_name'] as String,
      dataset: ds,
      epochs: json['epochs'] as int,
      batchSize: json['batch_size'] as int,
      learningRate: (json['learning_rate'] as num).toDouble(),
      progress: prog == null ? null : TrainingProgress(prog),
      modelId: json['model_id'] as String?,
      metrics: metrics == null ? null : ModelMetrics.fromJson(metrics),
      error: json['error'] as String?,
      createdAt: json['created_at'] as String,
      startedAt: json['started_at'] as String?,
      completedAt: json['completed_at'] as String?,
    );
  }
}

/// One candidate action proposed by a discovery run, a cluster of visually
/// similar frames, named "Action N" until a person renames it.
class DiscoveredCluster {
  const DiscoveredCluster({
    required this.id,
    required this.name,
    required this.frameCount,
  });

  final String id;
  final String name;
  final int frameCount;

  factory DiscoveredCluster.fromJson(Map<String, dynamic> json) => DiscoveredCluster(
        id: json['id'] as String,
        name: json['name'] as String,
        frameCount: json['frame_count'] as int,
      );
}

class DiscoveryJob {
  const DiscoveryJob({
    required this.discoveryJobId,
    required this.status,
    required this.videoPath,
    required this.originalFilename,
    required this.fps,
    required this.minClusterSize,
    this.clusters,
    this.progress,
    this.error,
    required this.createdAt,
    this.startedAt,
    this.completedAt,
  });

  final String discoveryJobId;
  final JobStatus status;
  final String videoPath;
  final String originalFilename;
  final int fps;
  final int minClusterSize;
  final List<DiscoveredCluster>? clusters;
  final TrainingProgress? progress;
  final String? error;
  final String createdAt;
  final String? startedAt;
  final String? completedAt;

  factory DiscoveryJob.fromJson(Map<String, dynamic> json) {
    final clusters = json['clusters'] as List<dynamic>?;
    final prog = json['progress'] as Map<String, dynamic>?;
    return DiscoveryJob(
      discoveryJobId: json['discovery_job_id'] as String,
      status: jobStatusFromString(json['status'] as String),
      videoPath: json['video_path'] as String,
      originalFilename: json['original_filename'] as String,
      fps: json['fps'] as int,
      minClusterSize: json['min_cluster_size'] as int,
      clusters: clusters
          ?.map((e) => DiscoveredCluster.fromJson(e as Map<String, dynamic>))
          .toList(),
      progress: prog == null ? null : TrainingProgress(prog),
      error: json['error'] as String?,
      createdAt: json['created_at'] as String,
      startedAt: json['started_at'] as String?,
      completedAt: json['completed_at'] as String?,
    );
  }
}

/// A reviewed discovery run saved as a reusable dataset.
class ActionDataset {
  const ActionDataset({
    required this.datasetId,
    required this.name,
    required this.actionCounts,
    required this.createdAt,
  });

  final String datasetId;
  final String name;
  final Map<String, int> actionCounts;
  final String createdAt;

  int get imageCount => actionCounts.values.fold(0, (s, v) => s + v);

  factory ActionDataset.fromJson(Map<String, dynamic> json) => ActionDataset(
        datasetId: json['dataset_id'] as String,
        name: json['name'] as String,
        actionCounts:
            (json['action_counts'] as Map<String, dynamic>).map((k, v) => MapEntry(k, v as int)),
        createdAt: json['created_at'] as String,
      );
}

class ActionDatasetDetail {
  const ActionDatasetDetail({
    required this.datasetId,
    required this.name,
    required this.createdAt,
    required this.actions,
  });

  final String datasetId;
  final String name;
  final String createdAt;

  /// {action name: absolute image paths}, the exact shape
  /// ApiClient.startTraining's `dataset` argument takes.
  final Map<String, List<String>> actions;

  factory ActionDatasetDetail.fromJson(Map<String, dynamic> json) => ActionDatasetDetail(
        datasetId: json['dataset_id'] as String,
        name: json['name'] as String,
        createdAt: json['created_at'] as String,
        actions: (json['actions'] as Map<String, dynamic>).map(
          (k, v) => MapEntry(k, (v as List<dynamic>).map((e) => e as String).toList()),
        ),
      );
}

class ModelInfo {
  const ModelInfo({
    required this.modelId,
    required this.name,
    required this.labels,
    required this.isActive,
    required this.isBundled,
    required this.createdAt,
    this.fusionAlpha,
    this.metrics,
    this.datasetVersion,
  });

  final String modelId;
  final String name;
  final List<String> labels;
  final bool isActive;

  /// True only for the bundled default, it has no registry row, so it
  /// can't be renamed or deleted (the sidecar rejects both).
  final bool isBundled;
  final String createdAt;
  final double? fusionAlpha;
  final ModelMetrics? metrics;
  final String? datasetVersion;

  factory ModelInfo.fromJson(Map<String, dynamic> json) {
    final metrics = json['metrics'] as Map<String, dynamic>?;
    return ModelInfo(
      modelId: json['model_id'] as String,
      name: json['name'] as String,
      labels: (json['labels'] as List<dynamic>).map((e) => e as String).toList(),
      isActive: json['is_active'] as bool,
      isBundled: json['is_bundled'] as bool? ?? false,
      createdAt: json['created_at'] as String,
      fusionAlpha: (json['fusion_alpha'] as num?)?.toDouble(),
      metrics: metrics == null ? null : ModelMetrics.fromJson(metrics),
      datasetVersion: json['dataset_version'] as String?,
    );
  }
}
