"""
Entry point the Flutter app spawns as a subprocess (see
lib/services/sidecar_service.dart) — `python run.py --port 8756`. Binds to
127.0.0.1 only, never 0.0.0.0: this process should never be reachable from
anything other than the Flutter app running on the same machine.
"""
import argparse
import os

# Belt-and-braces duplicate of app/__init__.py's setting — see that file for
# the full explanation of why legacy Keras 2 is required (models trained by
# app/training_pipeline.py must be loadable by app/ml/classifier.py's
# tf_keras-based loader). Repeated here so the guarantee holds even if this
# file ever grows an import that reaches TensorFlow before `app` is
# imported. Both use setdefault, so whichever runs first wins and the other
# is a no-op.
os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8756)
    args = parser.parse_args()

    # Imported here and passed as an OBJECT, not as the string
    # "app.main:app". uvicorn resolves a string form via importlib at
    # runtime, which means PyInstaller's static analysis never sees
    # `app.main` (or anything it imports) and leaves the entire application
    # out of the frozen bundle — the executable then dies immediately with
    # "Error loading ASGI app. Could not import module 'app.main'". A real
    # import statement is visible to that analysis, so the app and its whole
    # dependency tree get bundled.
    #
    # Inside main() rather than at module scope so the env vars set above
    # are already in place before anything can pull in TensorFlow.
    from app.main import app

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
