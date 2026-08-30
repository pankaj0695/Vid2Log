/// Spawns, health-checks, and tears down the local Python sidecar process.
/// This is the one piece of the app that talks to `dart:io.Process` instead
/// of the network; everything else goes through ApiClient over HTTP to
/// 127.0.0.1.
///
/// There are two ways the sidecar can exist, and this tries them in order:
///
///   1. BUNDLED (release builds), a standalone executable frozen with
///      PyInstaller and shipped inside the app, so end users need no
///      Python, pip, or virtualenv. See python_sidecar/vid2log_sidecar.spec
///      and RELEASE.md.
///   2. SOURCE (development), `python_sidecar/.venv/.../python run.py`,
///      found by walking up from the running executable. See
///      python_sidecar/README.md "Setup".
///
/// Preferring the bundle matters: a developer's machine has BOTH, and a
/// release build running the repo's venv instead of its own frozen copy
/// would appear to work locally while being broken for everyone else.
library;

import 'dart:async';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;

enum SidecarState { stopped, starting, running, failed }

class SidecarService {
  SidecarService({this.port = 8756});

  final int port;

  Process? _process;
  SidecarState _state = SidecarState.stopped;
  String? _lastError;
  final _stateController = StreamController<SidecarState>.broadcast();

  SidecarState get state => _state;
  String? get lastError => _lastError;
  Stream<SidecarState> get stateStream => _stateController.stream;
  String get baseUrl => 'http://127.0.0.1:$port';

  void _setState(SidecarState s) {
    _state = s;
    _stateController.add(s);
    if (s == SidecarState.running) {
      // Wake everything that was parked in waitUntilReady() below.
      if (_readyCompleter != null && !_readyCompleter!.isCompleted) {
        _readyCompleter!.complete(true);
      }
    } else if (s == SidecarState.failed) {
      if (_readyCompleter != null && !_readyCompleter!.isCompleted) {
        _readyCompleter!.complete(false);
      }
    } else if (s == SidecarState.starting) {
      // A fresh start attempt (including a Retry after a failure) needs a
      // fresh completer, the previous one may already have resolved false.
      if (_readyCompleter == null || _readyCompleter!.isCompleted) {
        _readyCompleter = Completer<bool>();
      }
    }
  }

  Completer<bool>? _readyCompleter;

  /// Resolves true once the sidecar is actually serving, false if it failed.
  ///
  /// This exists because the sidecar takes several seconds to boot (importing
  /// TensorFlow alone is most of it), while the Flutter UI is interactive
  /// immediately. Without this, every screen's initState() fired its first
  /// HTTP call into a port nobody was listening on yet and painted a
  /// "Connection refused" error, which then looked fine the moment you
  /// switched tabs, purely because by then the sidecar had finished booting.
  /// Screens await this before their first fetch instead.
  Future<bool> waitUntilReady() async {
    if (_state == SidecarState.running) return true;
    if (_state == SidecarState.failed) return false;
    _readyCompleter ??= Completer<bool>();
    return _readyCompleter!.future;
  }

  /// Walks upward from a starting directory looking for a `python_sidecar`
  /// folder as a direct child at each level.
  Future<Directory?> _searchUpwardsFrom(Directory start, int maxLevels) async {
    var dir = start;
    for (var i = 0; i < maxLevels; i++) {
      final candidate = Directory(p.join(dir.path, 'python_sidecar'));
      if (await candidate.exists()) return candidate;
      final parent = dir.parent;
      if (parent.path == dir.path) break; // reached filesystem root
      dir = parent;
    }
    return null;
  }

  /// Locates `python_sidecar` next to the Flutter project. Two strategies,
  /// tried in order:
  ///
  /// 1. `Platform.resolvedExecutable`, the path to the actual compiled
  ///    binary, e.g.
  ///    `<project>/build/macos/Build/Products/Debug/vid2log.app/Contents/MacOS/vid2log`.
  ///    This is the reliable one: when `flutter run -d macos` launches the
  ///    app via Xcode/the debugger (the common case, that's the "DEBUG"
  ///    ribbon you see on screen), `Directory.current` is *not* the project
  ///    root, it's wherever Xcode/the IDE happened to launch the process
  ///    from, which varies. The executable path, by contrast, always sits
  ///    at a fixed depth under the project root's `build/` folder, so
  ///    walking upward from it reliably finds `python_sidecar` as a sibling
  ///    of `build/`.
  /// 2. `Directory.current`, kept as a fallback for the case where the app
  ///    was launched by running the built binary directly from a terminal
  ///    sitting in the project root.
  Future<Directory?> _resolveSidecarDir() async {
    final envOverride = Platform.environment['VID2LOG_SIDECAR_DIR'];
    if (envOverride != null && envOverride.trim().isNotEmpty) {
      final dir = Directory(envOverride);
      if (await dir.exists()) return dir;
    }

    final fromExecutable = await _searchUpwardsFrom(
      Directory(p.dirname(Platform.resolvedExecutable)),
      15,
    );
    if (fromExecutable != null) return fromExecutable;

    return _searchUpwardsFrom(Directory.current, 8);
  }

  String _pythonExecutableFor(Directory sidecarDir) {
    if (Platform.isWindows) {
      return p.join(sidecarDir.path, '.venv', 'Scripts', 'python.exe');
    }
    return p.join(sidecarDir.path, '.venv', 'bin', 'python3');
  }

  /// How to launch the sidecar: the executable plus its arguments and the
  /// directory to run it from.
  ///
  /// The frozen build takes no `run.py` argument, PyInstaller baked that
  /// entry point into the binary itself, whereas the source build needs
  /// `python run.py`. Keeping both shapes in one record means `start()`
  /// doesn't branch on which mode it's in.
  ({String executable, List<String> args, String workingDirectory})? _launch;

  /// Path to the frozen sidecar shipped inside a release build, or null when
  /// this isn't a packaged build.
  ///
  /// macOS: the .app bundle puts it in `Contents/Resources/`, which is where
  /// the build script copies it, and `resolvedExecutable` is
  /// `…/Contents/MacOS/vid2log`, hence `../Resources`.
  /// Windows: everything ships flat in the install directory, so the folder
  /// simply sits beside the .exe.
  Future<String?> _bundledSidecarExecutable() async {
    final exeDir = Directory(p.dirname(Platform.resolvedExecutable));
    final binaryName = Platform.isWindows ? 'vid2log_sidecar.exe' : 'vid2log_sidecar';

    final candidates = <String>[
      if (Platform.isMacOS)
        p.join(exeDir.parent.path, 'Resources', 'vid2log_sidecar', binaryName),
      p.join(exeDir.path, 'vid2log_sidecar', binaryName),
      // Flutter on Windows/Linux stages bundled assets under `data/`; keep
      // this as a fallback in case the build script's copy target moves.
      p.join(exeDir.path, 'data', 'vid2log_sidecar', binaryName),
    ];

    for (final candidate in candidates) {
      if (await File(candidate).exists()) return candidate;
    }
    return null;
  }

  /// Works out how to start the sidecar, preferring the bundled executable
  /// over a source checkout. Returns null (and sets [_lastError]) if neither
  /// is available.
  Future<bool> _resolveLaunch() async {
    final bundled = await _bundledSidecarExecutable();
    if (bundled != null) {
      _launch = (
        executable: bundled,
        args: ['--port', '$port'],
        // Run from the binary's own folder so any relative path it resolves
        // lands inside the bundle rather than wherever the app was started.
        workingDirectory: p.dirname(bundled),
      );
      return true;
    }

    final sidecarDir = await _resolveSidecarDir();
    if (sidecarDir == null) {
      _lastError =
          'Could not find the sidecar. A packaged build should contain a '
          'vid2log_sidecar folder; a source checkout needs python_sidecar/ '
          'nearby. Set VID2LOG_SIDECAR_DIR to override.';
      return false;
    }

    final pythonExe = _pythonExecutableFor(sidecarDir);
    if (!await File(pythonExe).exists()) {
      _lastError =
          'Python sidecar virtualenv not found at $pythonExe. Follow the '
          'setup steps in python_sidecar/README.md ("Setup"), you need to '
          'create python_sidecar/.venv and `pip install -r requirements.txt` '
          'before this app can spawn it.';
      return false;
    }

    _launch = (
      executable: pythonExe,
      args: ['run.py', '--port', '$port'],
      workingDirectory: sidecarDir.path,
    );
    return true;
  }

  /// Starts the sidecar subprocess (if not already running) and waits until
  /// GET /health responds OK or [timeout] elapses. Safe to call repeatedly,
  /// it's a no-op while already starting/running.
  Future<void> start({Duration timeout = const Duration(seconds: 45)}) async {
    if (_state == SidecarState.starting || _state == SidecarState.running) {
      return;
    }

    _lastError = null;
    _setState(SidecarState.starting);

    // Adopt a sidecar that's already serving on this port instead of
    // spawning a second one. Without this, opening the packaged app while
    // a `flutter run` instance is alive (or after a previous launch left a
    // sidecar behind) starts a process that can't bind, so uvicorn exits
    // with "Address already in use", and the app reports a failure even
    // though a perfectly good sidecar is listening right there.
    //
    // _process stays null in this case, which is exactly right: this
    // instance didn't start that process and must not kill it on exit.
    if (await _isHealthy()) {
      _setState(SidecarState.running);
      return;
    }

    if (!await _resolveLaunch()) {
      _setState(SidecarState.failed);
      return;
    }
    final launch = _launch!;

    try {
      _process = await Process.start(
        launch.executable,
        launch.args,
        workingDirectory: launch.workingDirectory,
      );

      _recentOutput.clear();
      await _openLogSink();

      // The sidecar's output goes three places, and it needs all three:
      // the parent console (useful under `flutter run`), a log file (the
      // ONLY record when the app is launched from Finder, where stdout and
      // stderr are discarded), and an in-memory tail so a crash can be
      // explained in the UI instead of just reporting an exit code.
      _process!.stdout
          .transform(const SystemEncoding().decoder)
          .listen((chunk) => _onSidecarOutput(chunk, isError: false));
      _process!.stderr
          .transform(const SystemEncoding().decoder)
          .listen((chunk) => _onSidecarOutput(chunk, isError: true));

      _process!.exitCode.then((code) {
        _closeLogSink();
        if (_state != SidecarState.stopped) {
          final tail = _recentOutput.join().trim();
          _lastError = tail.isEmpty
              ? 'Sidecar process exited unexpectedly (code $code). '
                  'Full output: ${_logFile.path}'
              : 'Sidecar exited (code $code): ${_lastMeaningfulLine(tail)}  '
                  '· Full log: ${_logFile.path}';
          _setState(SidecarState.failed);
        }
      });
    } catch (e) {
      _lastError = 'Failed to launch sidecar process: $e';
      _setState(SidecarState.failed);
      return;
    }

    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      if (await _isHealthy()) {
        _setState(SidecarState.running);
        return;
      }
      await Future.delayed(const Duration(milliseconds: 500));
    }

    _lastError =
        'Sidecar did not respond on $baseUrl/health within '
        '${timeout.inSeconds}s. Log: ${_logFile.path}';
    _setState(SidecarState.failed);
  }

  // ── Sidecar output capture ─────────────────────────────────────────────
  //
  // A GUI app launched from Finder has no terminal attached, so anything
  // the sidecar prints is thrown away. That made a packaged-build crash
  // essentially undiagnosable: the UI could only report "exited (code 3)"
  // while the actual Python traceback vanished. Everything below exists so
  // the reason survives.

  /// Rolling tail of the sidecar's output. Bounded because a long-running
  /// job logs steadily and this must not grow without limit.
  final List<String> _recentOutput = [];
  static const _maxRecentChunks = 60;

  IOSink? _logSink;

  /// Lives next to the database rather than inside the app bundle, which is
  /// read-only once installed to /Applications.
  File get _logFile => File(
        p.join(
          Platform.environment['HOME'] ??
              Platform.environment['USERPROFILE'] ??
              Directory.systemTemp.path,
          '.vid2log',
          'sidecar.log',
        ),
      );

  Future<void> _openLogSink() async {
    try {
      await _logFile.parent.create(recursive: true);
      // Truncated per launch: the interesting content is why THIS run
      // failed, and an append-only log of every launch would bury it.
      _logSink = _logFile.openWrite(mode: FileMode.write);
      _logSink!.writeln('--- sidecar started ${DateTime.now()} ---');
      _logSink!.writeln('exec: ${_launch?.executable}');
    } catch (_) {
      // Logging is a diagnostic aid; failing to open it must never stop
      // the app from starting.
      _logSink = null;
    }
  }

  void _closeLogSink() {
    try {
      _logSink?.flush();
      _logSink?.close();
    } catch (_) {
      // Nothing useful to do if the log itself fails to close.
    }
    _logSink = null;
  }

  void _onSidecarOutput(String chunk, {required bool isError}) {
    (isError ? stderr : stdout).write('[sidecar] $chunk');
    _logSink?.write(chunk);

    _recentOutput.add(chunk);
    if (_recentOutput.length > _maxRecentChunks) {
      _recentOutput.removeAt(0);
    }
  }

  /// Picks the line most likely to explain a failure, for the one-line
  /// error banner.
  ///
  /// "Last non-empty line" alone is wrong, and was actively misleading in
  /// practice: uvicorn logs its shutdown sequence AFTER a failed startup,
  /// so a bind failure surfaced as the useless "Application shutdown
  /// complete" while the real `ERROR: [Errno 48] Address already in use`
  /// sat a few lines above. So look for an explicit error line first, and
  /// only fall back to the last line (which is where a Python traceback
  /// does put its exception).
  String _lastMeaningfulLine(String output) {
    final lines = output
        .split('\n')
        .map((l) => l.trim())
        .where((l) => l.isNotEmpty && !l.startsWith('File "'))
        .toList();
    if (lines.isEmpty) return output;

    final errorLine = lines.lastWhere(
      (l) =>
          l.contains('ERROR') ||
          l.contains('Error:') ||
          l.contains('Exception') ||
          l.contains('Errno'),
      orElse: () => lines.last,
    );
    return errorLine.length > 300 ? '${errorLine.substring(0, 300)}…' : errorLine;
  }

  Future<bool> _isHealthy() async {
    try {
      final res = await http
          .get(Uri.parse('$baseUrl/health'))
          .timeout(const Duration(seconds: 2));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// Kills the sidecar subprocess, if any. Call this from the app's
  /// dispose/shutdown path so a stray python process doesn't outlive the
  /// Flutter window.
  Future<void> stop() async {
    final proc = _process;
    _process = null;
    _setState(SidecarState.stopped);
    if (proc != null) {
      proc.kill(ProcessSignal.sigterm);
      // Give it a moment to shut down cleanly, then force-kill if it's
      // still around (mirrors typical subprocess-supervisor practice).
      final exited = await proc.exitCode
          .timeout(const Duration(seconds: 5), onTimeout: () => -1);
      if (exited == -1) {
        proc.kill(ProcessSignal.sigkill);
      }
    }
  }

  void dispose() {
    _stateController.close();
  }
}
