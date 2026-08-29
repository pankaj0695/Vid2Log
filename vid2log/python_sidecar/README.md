# **vid2log Python sidecar**

This is the "embedded Python" half of the offline desktop app (see
`FLUTTER_OFFLINE_FEASIBILITY.md` at the repo root — this is the chosen
architecture: a real local Python process, spawned and managed by the
Flutter app, talked to over `127.0.0.1` only, never touching the network).
It reuses the cloud backend's ML pipeline (`backend/app/ml/*`) essentially
unchanged — only the storage layer differs: local SQLite + local files
instead of Firestore + Cloud Storage.

**What's implemented right now:**

- Processing a video into a scene log + CSV export, fully offline.
- Training a custom model locally (`app/training_pipeline.py`) — the same
  MobileNetV2 + OCR-text-fusion pipeline as the cloud backend, including a
  real held-out test-set evaluation (CNN-only vs text-only vs fused,
  per-action precision/recall/F1, confusion matrix). Unlike the cloud
  version there's no upload: the dataset is a list of absolute paths to the
  user's own images, read in place and never copied or modified.
- A local model registry (`models` table + `~/.vid2log/models/{id}/`) with
  activate / rename / delete, and per-job model selection.
- Action discovery (`app/action_discovery.py`) — samples a demo video,
  embeds frames, clusters them, and proposes candidate actions to review
  and save as a reusable dataset. Uses MobileNetV2 + scikit-learn's HDBSCAN
  rather than the cloud version's DINOv2 + `hdbscan` package, so it needs
  no extra dependencies and no first-run model download; see that module's
  docstring for the full reasoning.
- Importing an existing log from a CSV (`POST /logs/import`).
- SPM / DSM pattern mining (`app/sequence_mining.py`, `app/analytics.py`) —
  the mining engine is copied verbatim from the cloud backend, so identical
  inputs give identical numbers.

That's the whole cloud feature set. The remaining gap versus the web app is
cosmetic rather than functional: no light-mode toggle, and Video logs can't
yet combine several logs into one CSV.

## Setup (do this once)

You need Python 3.11 (same reasoning as `backend/README.md` — the ML stack
here has the most reliable prebuilt wheels on 3.11) and the `tesseract`
OCR binary installed as a system dependency (not a Python package —
`pytesseract` just calls out to it):

```bash
cd python_sidecar
python3.11 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
```

**Apple Silicon note** — do *not* `pip install tensorflow-metal` here. Its
wheels routinely lag behind TensorFlow's, and a mismatched pair makes
TensorFlow fail at *import* time (`NotFoundError: dlopen(...
libmetal_plugin.dylib): Library not loaded: @rpath/
_pywrap_tensorflow_internal.so`), which kills the sidecar on startup. If
it somehow got installed, `pip uninstall -y tensorflow-metal` fixes it.
See the comment in `requirements.txt` for the full reasoning.

**Tesseract binary** — macOS: `brew install tesseract`. Windows: install
from the [UB-Mannheim Tesseract build](https://github.com/UB-Mannheim/tesseract/wiki)
and make sure `tesseract.exe` ends up on your `PATH` (the installer offers
to do this).

This exact `.venv` location (`python_sidecar/.venv`) matters — that's where
`lib/services/sidecar_service.dart` looks for the Python interpreter to
spawn. If you use a different location, update `_resolvePythonExecutable()`
there, or symlink.

## Running it standalone (for testing, without Flutter)

```bash
cd python_sidecar
source .venv/bin/activate
python run.py --port 8756
```

Then `curl http://127.0.0.1:8756/health` should return `{"status":"ok"}`,
and:

```bash
curl -X POST http://127.0.0.1:8756/jobs \
  -H "Content-Type: application/json" \
  -d '{"video_path": "/absolute/path/to/a/video.mp4", "fps": 2}'
```

should return a job with `"status": "queued"`; poll
`GET /jobs/{job_id}` until `"status": "done"`, then
`GET /jobs/{job_id}/csv` for the exported log. This is exactly what the
Flutter app does for you automatically — useful for isolating whether a
problem is in the Python pipeline or the Flutter side.

## Where local data lives

`~/.vid2log/` (works out identically on Windows via `Path.home()`):

- `vid2log.db` — SQLite, job metadata + scene logs.
- `models/` — empty for now; will hold locally-trained models once training
  (Phase 2) is wired up.

## Packaging

For a release build this directory gets frozen into a standalone
executable (`vid2log_sidecar.spec`, PyInstaller) with the default model and
Tesseract bundled inside it, and copied into the app — so end users need no
Python, pip, or virtualenv. `lib/services/sidecar_service.dart` prefers
that bundled binary and falls back to the `.venv` above for development.

See `RELEASE.md` at the Flutter project root for the full build process on
both platforms.
