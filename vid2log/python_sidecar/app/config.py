"""
All local-filesystem locations the sidecar uses. Everything lives under one
per-user app-data directory — there's no cloud storage, no Firestore, no
Redis in this build: SQLite for job/model metadata, and the filesystem for
model files. `Path.home()` resolves correctly on both Windows and macOS,
which is the whole reason it's used here instead of something
platform-specific.

Note what's conspicuously simpler than the cloud backend's config: no
signed-URL/bucket settings, because there's no upload step at all — the
video file the user picks is already sitting on their own disk, so the
sidecar just reads it from wherever Flutter's file picker says it is. The
cloud backend's entire "Cloud Storage as TEMPORARY storage" dance
(app/services/gcs_service.py + video_pipeline.py's download-then-delete
lifecycle) doesn't have an offline-desktop equivalent to build — it simply
isn't needed.
"""
from pathlib import Path

APP_DATA_DIR = Path.home() / ".vid2log"
APP_DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = APP_DATA_DIR / "vid2log.db"

# One subdirectory per locally-trained model_id, each holding keras_model.h5,
# labels.txt, meta.json, and optionally text_model.joblib — see
# app/ml/classifier.py::get_hybrid_classifier(). Written by
# app/training_pipeline.py.
MODELS_DIR = APP_DATA_DIR / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# Action discovery ("Create actions"). Two stages, matching the cloud
# backend's temp-vs-permanent split (see
# backend/app/services/action_discovery_pipeline.py's docstring):
#
#   DISCOVERY_TEMP_DIR/{job_id}/{cluster_id}/{n}.jpg
#       Preview frames from a discovery run, written before anyone has
#       reviewed anything. Deleted once the run is saved as a dataset, or
#       when the discovery job itself is deleted.
#
#   ACTION_DATASETS_DIR/{dataset_id}/{action name}/{n}.jpg
#       The kept frames after review, in the exact subfolder-per-action
#       layout that app/training_pipeline.py::scan_dataset_folder already
#       reads — so a saved dataset can be fed straight into training with
#       no conversion step at all.
DISCOVERY_TEMP_DIR = APP_DATA_DIR / "discovery_temp"
DISCOVERY_TEMP_DIR.mkdir(parents=True, exist_ok=True)

ACTION_DATASETS_DIR = APP_DATA_DIR / "action_datasets"
ACTION_DATASETS_DIR.mkdir(parents=True, exist_ok=True)
