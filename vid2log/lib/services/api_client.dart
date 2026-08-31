/// Thin HTTP wrapper around the Python sidecar's local API
/// (python_sidecar/app/main.py). Every call targets 127.0.0.1 only, see
/// SidecarService for how that process gets started in the first place.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../models/analytics.dart';
import '../models/job.dart';
import '../models/training.dart';

class ApiException implements Exception {
  ApiException(this.statusCode, this.detail);
  final int statusCode;
  final String detail;

  @override
  String toString() => detail;
}

class ApiClient {
  ApiClient({required this.baseUrl, this.waitUntilReady, http.Client? client})
      : _client = client ?? http.Client();

  /// Resolved per request rather than captured once, because the sidecar's
  /// port is not known until it has started and reported it (see
  /// SidecarService._activePort, which no longer hard-codes one). Every
  /// request goes through _ensureReady first, so by the time this is called
  /// the port is settled.
  final String Function() baseUrl;

  /// Resolves once the sidecar is actually listening, see
  /// SidecarService.waitUntilReady. Every request below awaits this first,
  /// so screens can fire their initial fetch from initState() without
  /// racing the sidecar's (multi-second, TensorFlow-import-dominated)
  /// startup and painting a spurious "Connection refused". Gating here
  /// rather than in each screen means no screen has to remember to do it.
  final Future<bool> Function()? waitUntilReady;

  final http.Client _client;

  Future<void> _ensureReady() async {
    if (waitUntilReady == null) return;
    final ok = await waitUntilReady!();
    if (!ok) {
      throw ApiException(
        503,
        'The local engine isn\'t running. See the banner at the top of the '
        'window for why, then hit Retry.',
      );
    }
  }

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('${baseUrl()}$path').replace(queryParameters: query);

  String _detailFrom(http.Response res) {
    try {
      final body = jsonDecode(res.body);
      if (body is Map && body['detail'] != null) {
        return body['detail'].toString();
      }
    } catch (_) {
      // fall through to raw body
    }
    return res.body;
  }

  Never _throw(http.Response res) => throw ApiException(res.statusCode, _detailFrom(res));

  Future<dynamic> _get(String path, [Map<String, String>? query]) async {
    await _ensureReady();
    final res = await _client.get(_uri(path, query));
    if (res.statusCode != 200) _throw(res);
    return jsonDecode(res.body);
  }

  Future<dynamic> _send(String method, String path, [Object? body]) async {
    await _ensureReady();
    final req = http.Request(method, _uri(path))
      ..headers['Content-Type'] = 'application/json';
    if (body != null) req.body = jsonEncode(body);
    final streamed = await _client.send(req);
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode != 200) _throw(res);
    return res.body.isEmpty ? null : jsonDecode(res.body);
  }

  Future<bool> health() async {
    try {
      final res = await _client
          .get(_uri('/health'))
          .timeout(const Duration(seconds: 3));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  // ── Video jobs ─────────────────────────────────────────────────────────

  /// Kicks off processing for a video already on the user's own disk,
  /// [videoPath] must be an absolute local path (Flutter's file_picker
  /// gives you exactly that; there's no upload step at all, see
  /// python_sidecar/app/video_pipeline.py's module docstring).
  ///
  /// [modelId] null means "use the active model, falling back to the
  /// bundled default", same semantics as the web app's "Use active model"
  /// dropdown option.
  Future<Job> createJob({
    required String videoPath,
    String? originalFilename,
    int fps = 2,
    String? modelId,
  }) async {
    final json = await _send('POST', '/jobs', {
      'video_path': videoPath,
      if (originalFilename != null) 'original_filename': originalFilename,
      'fps': fps,
      if (modelId != null) 'model_id': modelId,
    });
    return Job.fromJson(json as Map<String, dynamic>);
  }

  Future<List<Job>> listJobs({int limit = 50}) async {
    final list = await _get('/jobs', {'limit': '$limit'}) as List<dynamic>;
    return list.map((e) => Job.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<Job> getJob(String jobId) async {
    final json = await _get('/jobs/$jobId');
    return Job.fromJson(json as Map<String, dynamic>);
  }

  Future<Job> renameJob(String jobId, String displayName) async {
    final json = await _send('PATCH', '/jobs/$jobId', {'display_name': displayName});
    return Job.fromJson(json as Map<String, dynamic>);
  }

  Future<void> deleteJob(String jobId) => _send('DELETE', '/jobs/$jobId');

  /// Raw CSV bytes for the finished job's scene log, write these straight
  /// to whatever path the user picked in the save dialog.
  Future<Uint8List> getJobCsv(String jobId) async {
    await _ensureReady();
    final res = await _client.get(_uri('/jobs/$jobId/csv'));
    if (res.statusCode != 200) _throw(res);
    return res.bodyBytes;
  }

  /// Best-effort filename suggestion for the CSV save dialog, matching
  /// what the sidecar itself names the attachment (see main.py's
  /// Content-Disposition header) without needing a second round trip.
  String suggestedCsvFilename(Job job) {
    final base = job.originalFilename.contains('.')
        ? job.originalFilename.substring(
            0, job.originalFilename.lastIndexOf('.'))
        : job.originalFilename;
    return '${base}_analysis.csv';
  }

  /// Creates a finished log straight from a CSV already on disk, skipping
  /// the video pipeline, for logs produced by hand, exported from
  /// elsewhere, or exported from here and edited.
  Future<Job> importCsvLog(String csvPath) async {
    final json = await _send('POST', '/logs/import', {'csv_path': csvPath});
    return Job.fromJson(json as Map<String, dynamic>);
  }

  // ── Training ───────────────────────────────────────────────────────────

  /// Inspects a folder whose subfolders are action names, returning what
  /// the sidecar found without starting anything, powers the Train
  /// screen's folder-import preview.
  Future<List<ScannedAction>> scanDatasetFolder(String folderPath) async {
    final json = await _send('POST', '/train/scan-folder', {'folder_path': folderPath});
    final list = (json as Map<String, dynamic>)['actions'] as List<dynamic>;
    return list.map((e) => ScannedAction.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<TrainingJob> startTraining({
    required String modelName,
    required Map<String, List<String>> dataset,
    int epochs = 20,
    int batchSize = 16,
    double learningRate = 0.001,
    double trainFrac = 0.7,
    double valFrac = 0.15,
    double testFrac = 0.15,
  }) async {
    final json = await _send('POST', '/train', {
      'model_name': modelName,
      'dataset': dataset,
      'epochs': epochs,
      'batch_size': batchSize,
      'learning_rate': learningRate,
      'split': {'train': trainFrac, 'val': valFrac, 'test': testFrac},
    });
    return TrainingJob.fromJson(json as Map<String, dynamic>);
  }

  Future<List<TrainingJob>> listTrainingJobs({int limit = 50}) async {
    final list = await _get('/train', {'limit': '$limit'}) as List<dynamic>;
    return list.map((e) => TrainingJob.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<TrainingJob> getTrainingJob(String id) async {
    final json = await _get('/train/$id');
    return TrainingJob.fromJson(json as Map<String, dynamic>);
  }

  Future<TrainingJob> retryTraining(String id) async {
    final json = await _send('POST', '/train/$id/retry');
    return TrainingJob.fromJson(json as Map<String, dynamic>);
  }

  Future<void> deleteTrainingJob(String id) => _send('DELETE', '/train/$id');

  // ── Models ─────────────────────────────────────────────────────────────

  Future<List<ModelInfo>> listModels() async {
    final list = await _get('/models') as List<dynamic>;
    return list.map((e) => ModelInfo.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<ModelInfo> getModel(String modelId) async {
    final json = await _get('/models/$modelId');
    return ModelInfo.fromJson(json as Map<String, dynamic>);
  }

  Future<void> activateModel(String modelId) => _send('POST', '/models/$modelId/activate');

  Future<ModelInfo> renameModel(String modelId, String name) async {
    final json = await _send('PATCH', '/models/$modelId', {'name': name});
    return ModelInfo.fromJson(json as Map<String, dynamic>);
  }

  Future<void> deleteModel(String modelId) => _send('DELETE', '/models/$modelId');

  // ── Action discovery ("Create actions") ────────────────────────────────

  Future<DiscoveryJob> startDiscovery({
    required String videoPath,
    int fps = 2,
    int minClusterSize = 5,
  }) async {
    final json = await _send('POST', '/actions/discover', {
      'video_path': videoPath,
      'fps': fps,
      'min_cluster_size': minClusterSize,
    });
    return DiscoveryJob.fromJson(json as Map<String, dynamic>);
  }

  Future<List<DiscoveryJob>> listDiscoveryJobs() async {
    final list = await _get('/actions/discover') as List<dynamic>;
    return list.map((e) => DiscoveryJob.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<DiscoveryJob> getDiscoveryJob(String id) async {
    final json = await _get('/actions/discover/$id');
    return DiscoveryJob.fromJson(json as Map<String, dynamic>);
  }

  Future<void> deleteDiscoveryJob(String id) => _send('DELETE', '/actions/discover/$id');

  /// Absolute paths of one proposed action's preview frames, rendered
  /// directly with Image.file, since they're on this same machine.
  Future<List<String>> listClusterFrames(String discoveryJobId, String clusterId) async {
    final json = await _get('/actions/discover/$discoveryJobId/frames/$clusterId');
    return ((json as Map<String, dynamic>)['frames'] as List<dynamic>)
        .map((e) => e as String)
        .toList();
  }

  /// Saves a reviewed set of actions as a new dataset. [actions] maps a
  /// final action name to its kept image paths, merging two actions is
  /// just listing both sets of paths under one name.
  ///
  /// [discoveryJobId] is set when this came from reviewing a discovery run,
  /// so the sidecar can clean up that run's temp previews afterwards.
  Future<ActionDataset> createActionDataset({
    required String name,
    required Map<String, List<String>> actions,
    String? discoveryJobId,
  }) async {
    final json = await _send('POST', '/actions/datasets', {
      'name': name,
      if (discoveryJobId != null) 'discovery_job_id': discoveryJobId,
      'actions': [
        for (final e in actions.entries) {'name': e.key, 'images': e.value},
      ],
    });
    return ActionDataset.fromJson(json as Map<String, dynamic>);
  }

  /// Replaces an existing dataset's contents with an edited set of actions.
  Future<ActionDataset> updateActionDataset({
    required String datasetId,
    required String name,
    required Map<String, List<String>> actions,
  }) async {
    final json = await _send('PUT', '/actions/datasets/$datasetId', {
      'name': name,
      'actions': [
        for (final e in actions.entries) {'name': e.key, 'images': e.value},
      ],
    });
    return ActionDataset.fromJson(json as Map<String, dynamic>);
  }

  Future<List<ActionDataset>> listActionDatasets() async {
    final list = await _get('/actions/datasets') as List<dynamic>;
    return list.map((e) => ActionDataset.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// Full image paths per action, exactly the shape [startTraining]'s
  /// `dataset` argument wants.
  Future<ActionDatasetDetail> getActionDataset(String datasetId) async {
    final json = await _get('/actions/datasets/$datasetId');
    return ActionDatasetDetail.fromJson(json as Map<String, dynamic>);
  }

  Future<void> deleteActionDataset(String datasetId) =>
      _send('DELETE', '/actions/datasets/$datasetId');

  // ── Analytics ──────────────────────────────────────────────────────────

  Future<List<SpmPattern>> runSpm({
    required List<String> jobIds,
    required MiningOptions options,
    String sortBy = 's_support',
  }) async {
    final list = await _send('POST', '/analytics/spm', {
      'job_ids': jobIds,
      ...options.toJson(),
      'sort_by': sortBy,
    }) as List<dynamic>;
    return list.map((e) => SpmPattern.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<DsmPattern>> runDsm({
    required List<String> groupAJobIds,
    required List<String> groupBJobIds,
    required MiningOptions options,
    String testType = 'ttest_ind',
    double thresholdPValue = 0.1,
  }) async {
    final list = await _send('POST', '/analytics/dsm', {
      'group_a_job_ids': groupAJobIds,
      'group_b_job_ids': groupBJobIds,
      ...options.toJson(),
      'test_type': testType,
      'threshold_p_value': thresholdPValue,
    }) as List<dynamic>;
    return list.map((e) => DsmPattern.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// The statistical tests the DSM tab can offer, fetched rather than
  /// hardcoded so the UI can't drift from what the sidecar accepts.
  Future<List<String>> listTestTypes() async {
    final json = await _get('/analytics/test-types');
    return ((json as Map<String, dynamic>)['test_types'] as List<dynamic>)
        .map((e) => e as String)
        .toList();
  }

  void close() => _client.close();
}
