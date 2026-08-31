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

/// The line python_sidecar/run.py prints (to both stdout and stderr) as soon
/// as it has bound its socket, e.g. `VID2LOG_PORT=54312`. Must stay in sync
/// with that file's PORT_ANNOUNCEMENT.
const _kPortAnnouncement = 'VID2LOG_PORT=';

class SidecarService {
  SidecarService();

  /// The port the sidecar actually bound, learned from its own announcement
  /// rather than decided here.
  ///
  /// There is deliberately no fixed default. The sidecar is started with
  /// `--port 0`, which asks the OS for a port that is genuinely free right
  /// now, and it reports back which one it got. A hard-coded port (this was
  /// 8756) is a single point of failure on someone else's machine: another
  /// program can hold it, a stale sidecar from an earlier run can still own
  /// it, two copies of this app starting at once both want it, and on
  /// Windows it can sit inside a Hyper-V/WSL reserved range where bind()
  /// fails with "only one usage of each socket address is normally
  /// permitted" while netstat shows nothing holding it at all. All four of
  /// those surfaced as the same unrecoverable "Local engine failed to
  /// start" banner on a fresh install. An OS-assigned port has none of
  /// them.
  int? _activePort;

  /// Null until the sidecar has reported its port. Callers reach the API
  /// through ApiClient, which waits on [waitUntilReady] before touching
  /// this, so by the time a request is built the port is always known.
  int? get activePort => _activePort;

  Process? _process;
  SidecarState _state = SidecarState.stopped;
  String? _lastError;
  final _stateController = StreamController<SidecarState>.broadcast();

  SidecarState get state => _state;
  String? get lastError => _lastError;
  Stream<SidecarState> get stateStream => _stateController.stream;

  /// Port 0 stands in before the real port is known: nothing listens there,
  /// so a request that somehow slipped past [waitUntilReady] fails as a
  /// connection error instead of silently reaching the wrong service.
  String get baseUrl => 'http://127.0.0.1:${_activePort ?? 0}';

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
        // 0 = "any free port": see the note on _activePort for why nothing
        // here picks a number. run.py prints back the one it got.
        args: ['--port', '0'],
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
      args: ['run.py', '--port', '0'],
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

    // Adopt a sidecar that's already serving instead of spawning a second
    // one. Opening the packaged app while a `flutter run` instance is alive
    // (or a second window of the app itself) otherwise starts a whole extra
    // TensorFlow process for no reason. The port to check comes from the
    // file the last successful launch wrote, since it is no longer a
    // constant this code can assume.
    //
    // _process stays null in this case, which is exactly right: this
    // instance didn't start that process and must not kill it on exit.
    final recorded = await _readRecordedPort();
    if (recorded != null && await _isHealthy(recorded)) {
      _activePort = recorded;
      _setState(SidecarState.running);
      return;
    }

    if (!await _resolveLaunch()) {
      _setState(SidecarState.failed);
      return;
    }
    final launch = _launch!;

    try {
      _portAnnounced = Completer<int>();
      _announceBuffer = '';
      _processExited = false;
      // A sidecar that dies instantly can complete this with an error
      // before start() reaches its await below, and an error with no
      // listener is an unhandled async exception. This listener is only
      // here to absorb that; the real await still sees the error.
      _portAnnounced!.future.catchError((_) => -1);
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
        _processExited = true;
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
        // Last, so the message above is already in place when start()
        // wakes up and decides whether it has anything better to say.
        _failPortAnnouncement();
      });
    } catch (e) {
      _lastError = 'Failed to launch sidecar process: $e';
      _setState(SidecarState.failed);
      return;
    }

    // The sidecar binds its socket before it starts importing TensorFlow
    // and announces the port immediately, so this resolves in well under a
    // second even though the server itself is not accepting connections
    // yet. A process that dies first (a missing dependency in the frozen
    // bundle, say) completes this with an error via _failPortAnnouncement,
    // so this never waits out the full timeout for a corpse.
    final int announcedPort;
    try {
      announcedPort = await _portAnnounced!.future.timeout(timeout);
    } catch (_) {
      if (_state != SidecarState.failed) {
        _lastError =
            'The local engine started but never reported which port it is '
            'serving on. Log: ${_logFile.path}';
        _setState(SidecarState.failed);
      }
      return;
    }
    _activePort = announcedPort;

    if (await _waitForHealthy(announcedPort, timeout)) {
      // Recorded only now that it is known good, so the next launch adopts
      // this sidecar instead of starting a second one.
      await _recordPort(announcedPort);
      _setState(SidecarState.running);
      return;
    }

    // Only if nothing better is already on record: when the process died on
    // its own, the exit handler above has the actual reason (a traceback, a
    // bind failure), and overwriting that with a generic timeout would throw
    // away the one thing that explains the failure.
    if (_state != SidecarState.failed) {
      _lastError = _processExited
          ? 'The local engine stopped while starting up. Log: ${_logFile.path}'
          : 'Sidecar did not respond on $baseUrl/health within '
              '${timeout.inSeconds}s. Log: ${_logFile.path}';
      _setState(SidecarState.failed);
    }
  }

  /// Completes with the port from the sidecar's `VID2LOG_PORT=` line, or
  /// with an error if the process dies before printing one.
  Completer<int>? _portAnnounced;

  /// Set the moment the sidecar process exits, so the health poll below can
  /// stop waiting on a corpse.
  bool _processExited = false;

  /// Polls GET /health on [healthPort] until it succeeds, the process dies,
  /// or [timeout] elapses.
  ///
  /// The dead-process check matters more than it looks. The port is now
  /// announced before the sidecar's slow imports run, so a crash *during*
  /// those imports lands after the announcement; without this the app would
  /// sit through the entire timeout before saying anything, then report a
  /// vague "did not respond" instead of the traceback the exit handler had
  /// already captured seconds earlier.
  Future<bool> _waitForHealthy(int healthPort, Duration timeout) async {
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      if (await _isHealthy(healthPort)) return true;
      if (_processExited) return false;
      await Future.delayed(const Duration(milliseconds: 500));
    }
    return false;
  }

  /// Rolling window of recent output, kept only until the port is found.
  /// The announcement can straddle two chunks, and half a port number is
  /// worse than none, so matching happens across the join rather than
  /// within one chunk.
  String _announceBuffer = '';

  /// Picks the announced port out of the sidecar's output. run.py prints the
  /// line to stdout *and* stderr, so this can fire twice; the completer
  /// guard makes the second one a no-op.
  void _maybeCapturePort(String chunk) {
    final pending = _portAnnounced;
    if (pending == null || pending.isCompleted) return;

    _announceBuffer += chunk;
    // The trailing \s is what proves the number is complete rather than cut
    // off at a chunk boundary; run.py prints the line with a newline.
    final match = RegExp('$_kPortAnnouncement(\\d+)\\s').firstMatch(_announceBuffer);
    if (match == null) {
      if (_announceBuffer.length > 512) {
        _announceBuffer = _announceBuffer.substring(_announceBuffer.length - 512);
      }
      return;
    }

    final parsed = int.tryParse(match.group(1)!);
    if (parsed != null && parsed > 0) {
      _announceBuffer = '';
      pending.complete(parsed);
    }
  }

  /// Unblocks the port wait when the process exits without ever announcing
  /// one, so start() reports the real reason (which the exit handler has
  /// already put in _lastError) rather than a timeout.
  void _failPortAnnouncement() {
    final pending = _portAnnounced;
    if (pending != null && !pending.isCompleted) {
      pending.completeError(StateError('sidecar exited before announcing a port'));
    }
  }

  /// Where the last known-good port is remembered between launches. Next to
  /// the log rather than in the install directory, which is read-only once
  /// the app is installed under Program Files.
  File get _portFile => File(p.join(_dataDir, '.vid2log', 'sidecar.port'));

  Future<int?> _readRecordedPort() async {
    try {
      if (!await _portFile.exists()) return null;
      return int.tryParse((await _portFile.readAsString()).trim());
    } catch (_) {
      // An unreadable hint file is not worth failing a launch over, the
      // caller just starts its own sidecar.
      return null;
    }
  }

  Future<void> _recordPort(int value) async {
    try {
      await _portFile.parent.create(recursive: true);
      await _portFile.writeAsString('$value');
    } catch (_) {
      // Losing the hint only costs a duplicate sidecar next launch.
    }
  }

  Future<void> _forgetRecordedPort() async {
    try {
      if (await _portFile.exists()) await _portFile.delete();
    } catch (_) {
      // Same as above: a stale hint is handled by health-checking it.
    }
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

  /// The user's home directory, where this app keeps everything it writes.
  String get _dataDir =>
      Platform.environment['HOME'] ??
      Platform.environment['USERPROFILE'] ??
      Directory.systemTemp.path;

  /// Lives next to the database rather than inside the app bundle, which is
  /// read-only once installed to /Applications.
  File get _logFile => File(p.join(_dataDir, '.vid2log', 'sidecar.log'));

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
    _maybeCapturePort(chunk);

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

  /// Whether something is answering /health as this app's engine on
  /// [healthPort]. Takes the port explicitly because it is also used to vet
  /// a port remembered from a previous launch, before [_activePort] is set.
  Future<bool> _isHealthy(int healthPort) async {
    try {
      final res = await http
          .get(Uri.parse('http://127.0.0.1:$healthPort/health'))
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
    _activePort = null;
    _setState(SidecarState.stopped);
    if (proc != null) {
      // Only the instance that started this sidecar clears the hint: an
      // adopted one (proc == null) belongs to another window that is still
      // using it.
      await _forgetRecordedPort();
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
