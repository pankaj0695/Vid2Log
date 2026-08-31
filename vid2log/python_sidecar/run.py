"""
Entry point the Flutter app spawns as a subprocess (see
lib/services/sidecar_service.dart), `python run.py --port 0`. Binds to
127.0.0.1 only, never 0.0.0.0: this process should never be reachable from
anything other than the Flutter app running on the same machine.

TWO THINGS HERE ARE LOAD-BEARING, and both exist because of the same bug:
a freshly installed app on a clean Windows machine died on launch with
`[Errno 10048] only one usage of each socket address ... is normally
permitted`, the Windows spelling of "address already in use".

  1. The listening socket is bound HERE, at the top of main(), instead of
     by uvicorn at the bottom. Binding is what actually claims a port from
     the OS, and it used to happen only after `from app.main import app`
     had pulled in TensorFlow, which on a cold machine takes tens of
     seconds. So a sidecar spent its whole startup NOT holding the port it
     was about to need, and a second sidecar starting in that window (the
     installer's "Launch Vid2Log" checkbox firing while the user also
     double-clicks the new shortcut is enough) saw a free port, decided it
     was fine, and only collided at the very end when both finally reached
     bind(). Claiming the socket first shrinks that window from "the whole
     TensorFlow import" to microseconds.

  2. `--port 0` asks the OS for any free port rather than hard-coding one.
     A fixed port is a single point of failure on someone else's machine:
     another program may hold it, a stale sidecar from a previous run may
     still own it, and on Windows it may sit inside a Hyper-V/WSL reserved
     range, where bind() fails with this same error while netstat shows
     nothing at all. The OS hands out a port that is genuinely free, so
     none of those can bite. The Flutter app learns which one via the
     VID2LOG_PORT line printed below.

An explicit `--port N` is still honoured exactly as before (scripts and
manual runs use it, e.g. scripts/build_windows.ps1's smoke test), and still
fails loudly if that specific port is unavailable, since a caller asking for
one particular port wants to know when it didn't get it.
"""
import argparse
import os
import socket
import sys

# Belt-and-braces duplicate of app/__init__.py's setting, see that file for
# the full explanation of why legacy Keras 2 is required (models trained by
# app/training_pipeline.py must be loadable by app/ml/classifier.py's
# tf_keras-based loader). Repeated here so the guarantee holds even if this
# file ever grows an import that reaches TensorFlow before `app` is
# imported. Both use setdefault, so whichever runs first wins and the other
# is a no-op.
os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")

import uvicorn

#: Prefix of the line the Flutter app greps stdout/stderr for to discover
#: which port this process actually got. Must stay in sync with
#: lib/services/sidecar_service.dart's _kPortAnnouncement.
PORT_ANNOUNCEMENT = "VID2LOG_PORT="


def _announce_port(port: int) -> None:
    """Tell the parent process which port we bound.

    Written to both streams because this one line is the app's only way to
    reach us, and a frozen build can leave one of the two unusable. A
    duplicate line in the log is a cheap price for that.
    """
    line = f"{PORT_ANNOUNCEMENT}{port}"
    for stream in (sys.stdout, sys.stderr):
        try:
            print(line, file=stream, flush=True)
        except Exception:
            # Losing the log line must never take the server down with it,
            # the other stream still carries the message.
            pass


def _bind(port: int) -> socket.socket:
    """Claim `port` (0 = let the OS choose) on the loopback interface."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)

    # Deliberately NOT set on Windows. There SO_REUSEADDR doesn't mean
    # "reuse a port stuck in TIME_WAIT" as it does on Unix, it means "let
    # this bind steal a port another live socket already holds", which
    # would turn a clean bind failure into two servers fighting over one
    # port, reintroducing exactly the class of bug this file exists to
    # prevent.
    if os.name != "nt":
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)

    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        sock.close()
        raise
    return sock


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="TCP port to serve on. 0 (the default) asks the OS for a free one.",
    )
    args = parser.parse_args()

    try:
        sock = _bind(args.port)
    except OSError as exc:
        print(
            f"ERROR: could not bind 127.0.0.1:{args.port}: {exc}",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(3) from exc

    # getsockname() rather than args.port: with --port 0 the requested port
    # is 0 and the real one is only knowable after bind().
    port = sock.getsockname()[1]
    _announce_port(port)

    # Imported here and passed as an OBJECT, not as the string
    # "app.main:app". uvicorn resolves a string form via importlib at
    # runtime, which means PyInstaller's static analysis never sees
    # `app.main` (or anything it imports) and leaves the entire application
    # out of the frozen bundle, the executable then dies immediately with
    # "Error loading ASGI app. Could not import module 'app.main'". A real
    # import statement is visible to that analysis, so the app and its whole
    # dependency tree get bundled.
    #
    # Inside main() rather than at module scope so the env vars set above
    # are already in place before anything can pull in TensorFlow, and so
    # the socket above is already claimed before this slow import starts.
    from app.main import app

    # Serving on the socket bound above. host/port on the Config are unused
    # in this mode, uvicorn calls listen() on whatever socket it is handed.
    config = uvicorn.Config(app, log_level="info")
    uvicorn.Server(config).run(sockets=[sock])


if __name__ == "__main__":
    main()
