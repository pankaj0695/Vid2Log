/// Data models mirroring the Python sidecar's Pydantic schemas
/// (python_sidecar/app/schemas.py: SceneRow, JobOut). Kept field-for-field
/// identical to that JSON shape so `fromJson` is a straight decode with no
/// renaming games.
library;

class Scene {
  final String startTime;
  final String endTime;
  final String duration;
  final String action;
  final double confidence;
  final String source;

  const Scene({
    required this.startTime,
    required this.endTime,
    required this.duration,
    required this.action,
    required this.confidence,
    required this.source,
  });

  factory Scene.fromJson(Map<String, dynamic> json) {
    return Scene(
      startTime: json['start_time'] as String,
      endTime: json['end_time'] as String,
      duration: json['duration'] as String,
      action: json['action'] as String,
      confidence: (json['confidence'] as num).toDouble(),
      source: json['source'] as String,
    );
  }
}

/// Mirrors the sidecar's `status` field values exactly
/// (see python_sidecar/app/db.py / video_pipeline.py).
enum JobStatus { queued, processing, done, failed }

JobStatus jobStatusFromString(String s) {
  switch (s) {
    case 'queued':
      return JobStatus.queued;
    case 'processing':
      return JobStatus.processing;
    case 'done':
      return JobStatus.done;
    case 'failed':
      return JobStatus.failed;
    default:
      throw ArgumentError('Unknown job status: $s');
  }
}

class Job {
  final String jobId;
  final JobStatus status;
  final String videoPath;
  final String originalFilename;
  final String? displayName;
  final String? modelId;
  final int fps;
  final int? sceneCount;
  final List<Scene>? scenes;
  final String? error;
  final String createdAt;
  final String? startedAt;
  final String? completedAt;

  const Job({
    required this.jobId,
    required this.status,
    required this.videoPath,
    required this.originalFilename,
    this.displayName,
    this.modelId,
    required this.fps,
    this.sceneCount,
    this.scenes,
    this.error,
    required this.createdAt,
    this.startedAt,
    this.completedAt,
  });

  /// What to show in a job list — the user-chosen rename if they've set
  /// one, otherwise fall back to the original video filename.
  String get label =>
      (displayName != null && displayName!.trim().isNotEmpty)
          ? displayName!
          : originalFilename;

  factory Job.fromJson(Map<String, dynamic> json) {
    final scenesJson = json['scenes'] as List<dynamic>?;
    return Job(
      jobId: json['job_id'] as String,
      status: jobStatusFromString(json['status'] as String),
      videoPath: json['video_path'] as String,
      originalFilename: json['original_filename'] as String,
      displayName: json['display_name'] as String?,
      modelId: json['model_id'] as String?,
      fps: json['fps'] as int,
      sceneCount: json['scene_count'] as int?,
      scenes: scenesJson
          ?.map((e) => Scene.fromJson(e as Map<String, dynamic>))
          .toList(),
      error: json['error'] as String?,
      createdAt: json['created_at'] as String,
      startedAt: json['started_at'] as String?,
      completedAt: json['completed_at'] as String?,
    );
  }
}
