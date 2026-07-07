# vid2log backend (FastAPI)

Replaces the manual Teachable-Machine → single-video Streamlit workflow with
one API: video upload → parallel processing → logs, plus an in-app training
module with real test-set metrics, a model registry, and SPM/DSM analytics.

## How video storage actually works (important)

Videos are **never stored permanently**. The frontend uploads a video
directly to Cloudinary using an **unsigned** upload preset (so the API
key/secret never touch the browser), then calls `POST /jobs` with the
Cloudinary reference it got back. A worker downloads the video to local disk,
classifies it, saves the resulting log to Firestore, deletes its local copy,
and then **deletes the video from Cloudinary** — the video only exists for
the duration of one processing job. Only small durable artifacts persist:
scene logs (Firestore) and trained `.h5` models (Cloudinary, `resource_type=raw`).

`POST /admin/cleanup-stale-videos` is a safety net for the rare case a worker
crashes mid-job and skips its own cleanup — schedule it (cron / Cloud
Scheduler) to run daily.

## Setup

Use **Python 3.11** — the whole ML stack here (`tensorflow-macos`, `opencv-python-headless`, etc.) has the most reliably prebuilt wheels on 3.11. Python 3.14 is too new (no `tensorflow-macos` build exists for it yet), and some 3.12 environments have been seen pulling in unbuildable ancient package versions when wheels aren't available for that exact interpreter.

```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env   # then fill in the values below
```

If `python3.11` isn't installed: `brew install python@3.11` (macOS).

Fill in `.env`:

- **Cloudinary**: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
  from your Cloudinary dashboard, and `CLOUDINARY_UPLOAD_PRESET_NAME` — the
  **unsigned** preset you already created (Cloudinary console → Settings →
  Upload → Upload presets → Signing mode: Unsigned). Tag it (or have the
  frontend tag each upload) with `vid2log_temp` so the cleanup job can find it.
- **Firebase**: the web-app config values (`FIREBASE_*`) are mostly for the
  Next.js frontend. For the *backend* to verify tokens and use Firestore, you
  additionally need a **service account key**: Firebase Console → Project
  Settings → Service Accounts → Generate new private key → save the JSON as
  `backend/firebase-service-account.json` and make sure
  `GOOGLE_APPLICATION_CREDENTIALS` in `.env` points at it. Without this, the
  API still starts, but any auth-protected endpoint returns `503`.
- **Redis**: `REDIS_URL` — run `docker compose up redis` or a local Redis
  install for development.

## Running locally

```bash
# Terminal 1 — Redis (skip if you already have one running)
docker run -p 6379:6379 redis:7-alpine

# Terminal 2 — API
python -m uvicorn app.main:app --reload --port 8000

# Terminal 3 — worker (run more of these to process more jobs in parallel)
python -m app.worker
```

Or everything at once:

```bash
docker compose up --build
```

API docs: `http://localhost:8000/docs`

## Endpoints

| Method | Path                            | Purpose                                                                                       |
| ------ | ------------------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/health`                     | Liveness + whether Firebase is configured                                                     |
| GET    | `/config/cloudinary`          | Non-secret config for the frontend's unsigned upload widget                                   |
| POST   | `/jobs`                       | Register an already-Cloudinary-uploaded video and enqueue processing                          |
| GET    | `/jobs` / `/jobs/{id}`      | List / check status of your jobs                                                              |
| DELETE | `/jobs/{id}`                  | Best-effort cancel (only while still queued)                                                  |
| GET    | `/logs/{job_id}`              | Scene rows as JSON                                                                            |
| GET    | `/logs/{job_id}/csv`          | Same data as a downloadable CSV                                                               |
| POST   | `/logs/combine`               | Merge several jobs' logs into one CSV                                                         |
| GET    | `/models` / `/models/{id}`  | Model registry                                                                                |
| POST   | `/models`                     | Manually register an externally-trained model (e.g. from Teachable Machine)                   |
| PATCH  | `/models/{id}/activate`       | Set the default model for new jobs                                                            |
| POST   | `/train`                      | Kick off the in-app training pipeline (MobileNetV2 transfer learning + full test-set metrics) |
| GET    | `/train/{id}`                 | Training status + metrics report                                                              |
| POST   | `/analytics/spm`              | Sequential Pattern Mining across a set of videos                                              |
| POST   | `/analytics/dsm`              | Differential Sequence Mining between two groups of videos                                     |
| POST   | `/admin/cleanup-stale-videos` | Safety-net cleanup for orphaned Cloudinary videos                                             |

All endpoints except `/health` and `/config/cloudinary` require
`Authorization: Bearer <Firebase ID token>`.

## Notes / current limitations

- The training pipeline (`app/services/training_pipeline.py`) is a real,
  working first version: frozen MobileNetV2 backbone, no augmentation yet,
  fixed hyperparameters beyond epochs. Phase 3 of the project plan extends
  this with augmentation, deeper fine-tuning, and experiment tracking
  (MLflow/W&B) — the API shape here doesn't need to change for that.
- `DELETE /jobs/{id}` can't interrupt a job a worker has already started
  (RQ doesn't support clean mid-job cancellation) — it only prevents a
  still-queued job from starting.
- Default bundled model (`app/ml/default_model/`) is the existing
  `keras_model.h5` / `labels.txt` from `streamlit_application/new_model/game_keras/`,
  so a job with no `model_id` behaves exactly like the current Streamlit app.
