/// New job screen: pick a video already on disk (no upload — the sidecar
/// reads the path directly, see api_client.dart's createJob docstring),
/// set a sampling rate, and submit.
library;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../services/api_client.dart';
import 'job_detail_screen.dart';

class NewJobScreen extends StatefulWidget {
  const NewJobScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<NewJobScreen> createState() => _NewJobScreenState();
}

class _NewJobScreenState extends State<NewJobScreen> {
  String? _videoPath;
  String? _videoName;
  int _fps = 2;
  bool _submitting = false;
  String? _error;

  Future<void> _pickVideo() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.video,
      withData: false,
    );
    if (result == null || result.files.isEmpty) return;
    final file = result.files.single;
    if (file.path == null) {
      setState(() => _error = 'Could not resolve a local path for that file.');
      return;
    }
    setState(() {
      _videoPath = file.path;
      _videoName = file.name;
      _error = null;
    });
  }

  Future<void> _submit() async {
    if (_videoPath == null) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final job = await widget.apiClient.createJob(
        videoPath: _videoPath!,
        originalFilename: _videoName,
        fps: _fps,
      );
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute(
          builder: (_) => JobDetailScreen(
            apiClient: widget.apiClient,
            jobId: job.jobId,
          ),
        ),
      );
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('New job')),
      body: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Card(
              child: ListTile(
                leading: const Icon(Icons.movie_outlined),
                title: Text(_videoName ?? 'No video selected'),
                subtitle: Text(_videoPath ?? 'Choose a video file from your computer'),
                trailing: OutlinedButton(
                  onPressed: _submitting ? null : _pickVideo,
                  child: const Text('Choose…'),
                ),
              ),
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                const Text('Sampling rate:'),
                const SizedBox(width: 12),
                Expanded(
                  child: Slider(
                    value: _fps.toDouble(),
                    min: 1,
                    max: 5,
                    divisions: 4,
                    label: '$_fps fps',
                    onChanged: _submitting
                        ? null
                        : (v) => setState(() => _fps = v.round()),
                  ),
                ),
                SizedBox(width: 48, child: Text('$_fps fps')),
              ],
            ),
            const Text(
              'Higher sampling rates catch shorter scene changes but take '
              'longer to process. 2 fps matches the cloud backend default.',
              style: TextStyle(color: Colors.grey, fontSize: 12),
            ),
            const SizedBox(height: 24),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(_error!, style: const TextStyle(color: Colors.red)),
              ),
            FilledButton.icon(
              onPressed: (_videoPath == null || _submitting) ? null : _submit,
              icon: _submitting
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.play_arrow),
              label: Text(_submitting ? 'Starting…' : 'Process video'),
            ),
          ],
        ),
      ),
    );
  }
}
