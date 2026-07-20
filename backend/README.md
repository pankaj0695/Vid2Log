# vid2log backend (FastAPI)

Replaces the manual Teachable-Machine → single-video Streamlit workflow with
one API: video upload → parallel processing → logs, plus an in-app training
module with real test-set metrics, a model registry, and SPM/DSM analytics.

## How video storage actually works (important)

Videos are **never stored permanently**, and storage is a **standalone
Google Cloud Storage bucket — not Firebase Storage** (Firebase Storage
requires the whole Firebase project to be on the pay-as-you-go Blaze plan;
a plain GCS bucket does not, and stays within Cloud Storage's own free
tier for light usage). The flow:

1. The frontend calls `POST /uploads/signed-url` with `{filename, content_type, kind}` (`kind` is `"video"` or `"training-image"`). The
   backend (`app/routers/uploads.py`) returns a short-lived **V4 signed PUT
   URL** scoped under `{video-uploads|training-uploads}/{uid}/...` — a path
   only that signed URL (not the client) controls, so one user can never
   overwrite another's blob.
2. The browser `PUT`s the raw file bytes straight to that URL
   (`frontend/lib/gcs.ts`) — the bytes never pass through our own server.
3. The frontend calls `POST /jobs` (or `POST /train`) with the `storage_path`
   it got back.
4. A worker downloads the blob to local disk (`app/services/gcs_service.py`,
   using the backend's own service-account credentials — no public URL
   involved anywhere in this flow), processes it, saves results to
   Firestore, deletes its local copy, and then **deletes the blob from
   Cloud Storage** — the video only exists for the duration of one
   processing job. Only small durable artifacts persist long-term: scene
   logs (Firestore) and trained `.h5`/`.joblib` model files (Cloud Storage,
   permanently, under `models/{model_id}/`).

This used to be Cloudinary (unsigned upload preset); it moved to Cloud
Storage because Cloudinary's free plan caps raw-file uploads at 10MB, which
trained model files routinely exceed.

`POST /admin/cleanup-stale-videos` is a safety net for the rare case a worker
crashes mid-job and skips its own cleanup — schedule it (cron / Cloud
Scheduler) to run daily. It lists blobs under `video-uploads/` older than
`older_than_hours` (via each blob's own `time_created`, no manual tagging
needed) and deletes them.

**Training images work the same way — deleted on success only.** `POST /train`
takes `{storage_path}` per image per class (the frontend uploads training
images the same signed-URL flow as videos, under `training-uploads/`). The
worker downloads them, trains, and deletes every one of them right after a
successful run — same policy as videos. A **failed** run keeps its images
around on purpose: `POST /train/{id}/retry` re-enqueues the exact same
dataset (same storage paths straight from the job's Firestore doc — it
reuses the SAME training_job_id/doc rather than creating a new one), so a
transient failure — a local TensorFlow/environment issue, a Redis/DNS
hiccup, whatever — doesn't cost the user a re-upload. Cloud Storage ends up
holding, long-term, only: `.h5`/`.joblib` model files, whatever video is
mid-processing, and any failed training job's images until it's retried or
abandoned.

## Cloud Storage setup

This is a **plain GCS bucket**, separate from anything Firebase manages —
you create it directly in Cloud Console / gcloud, on the same GCP project
your Firebase project already uses (Firebase Console → Project Settings
shows the project ID; it's the same project in Cloud Console).

1. **Create the bucket** (pick any globally-unique name; a region close to
   your users is fine):

   ```bash
   gcloud storage buckets create gs://YOUR_BUCKET_NAME --project=YOUR_PROJECT_ID --location=YOUR_REGION
   ```

   or via Cloud Console → Cloud Storage → Buckets → **Create**. Copy the
   bucket name into `GCS_BUCKET_NAME` in backend `.env` — the frontend never
   needs to know the bucket name; it only ever calls the backend.
2. **Grant the service account bucket access.** This is the SAME service
   account JSON key already used for `GOOGLE_APPLICATION_CREDENTIALS`
   (Firebase Console → Project Settings → Service Accounts → the key you
   generated). Give it the **Storage Object Admin** role, scoped to just
   this bucket (least privilege — no need for project-wide Storage Admin):

   ```bash
   gcloud storage buckets add-iam-policy-binding gs://vid2log-pankaj-bucket \
     --member="serviceAccount:firebase-adminsdk-fbsvc@vid2log-pankaj.iam.gserviceaccount.com" \
     --role="roles/storage.objectAdmin"
   ```

   `YOUR_SERVICE_ACCOUNT_EMAIL` is the `client_email` field inside the JSON
   key file. Without this, uploads/downloads/signed-URL generation all fail
   with a 403.
3. **Configure CORS**, so the browser is allowed to `PUT` directly to
   `storage.googleapis.com` from your frontend's origin. Create a
   `cors.json`:

   ```json
   [
     {
       "origin": ["http://localhost:3000", "https://your-production-domain.com"],
       "method": ["PUT"],
       "responseHeader": ["Content-Type"],
       "maxAgeSeconds": 3600
     }
   ]
   ```

   then apply it:

   ```bash
   gcloud storage buckets update gs://vid2log-pankaj-bucket --cors-file=cors.json
   ```

   Skipping this step is the single most common failure mode here — the
   signed URL itself works fine (you can `curl -T file gs_signed_url`), but
   the browser's own preflight `OPTIONS` request gets rejected, showing up
   as a vague "Failed to fetch" / CORS error in the browser console.
4. No separate credentials file is needed beyond what's already set —
   `app/services/gcs_service.py` uses the same
   `GOOGLE_APPLICATION_CREDENTIALS` JSON key as Firebase Admin, via
   `google.cloud.storage.Client`, entirely independent of
   `firebase_admin.storage` (nothing here is Firebase-managed).

## The API process never imports TensorFlow (important if you touch queue_service.py)

`app/services/queue_service.py` enqueues jobs by **dotted string reference**
(`"app.services.training_pipeline.run_training_job"`), not by importing the
function and passing it directly. This is deliberate: `training_pipeline.py`
and `video_pipeline.py` both import TensorFlow at module load time, and a
direct function reference would force the lightweight API process to import
that whole ML stack just to enqueue a job. RQ resolves a string reference
lazily, inside the *worker* process, only when a job is actually dequeued.

Skipping this isn't just a performance nicety — it's the difference between
"a broken local TensorFlow install breaks in-progress training" (fine, shows
up as a failed job, retryable) and "a broken local TensorFlow install breaks
the ability to submit ANY job, video or training, with a 500 that also
strips CORS headers because it's an unhandled exception" (confusing, looks
like a frontend/CORS bug, and — worse — since the crash happens before the
job is actually pushed to Redis, the job's Firestore doc is stuck at
`status: "queued"` forever with no worker ever going to pick it up). If you
add a new job type, keep using the string-reference form.

## Users and roles

Firebase Auth handles identity; a separate Firestore `users` collection holds
the one thing Auth doesn't: role. `POST /users/bootstrap` is called by the
frontend right after every sign-in/sign-up — it creates `users/{uid}` with
`role: "user"` the first time it sees that uid, and never touches role again
after that (so a client can never grant itself admin, even though it can call
the endpoint freely). `GET /users/me` is the cheap read used to decide what
nav/routes to show. To make someone an admin, edit their `users/{uid}` doc in
the Firestore console (or call `PATCH /admin/users/{uid}/role` as an existing
admin) and set `role: "admin"` — there is deliberately no self-service way to
do this. Every `/admin/*` endpoint requires `role: "admin"`, checked fresh
from Firestore on each request (`require_admin` in `firebase_service.py`).

## CNN + OCR text fusion (for visually-similar screens)

Screen-recording UI screens often look near-identical to a CNN even when they're
different classes — the on-screen text (headers, labels) is usually the real
signal. `app/ml/hybrid_classifier.py` combines both, in three tiers, run in order:

1. **Keyword rules** (`app/ml/text_rules.py`) — a fuzzy-matched, hand-maintained
   list of phrases per class (`models/{id}.keyword_rules`), edited anytime via
   `PATCH /models/{id}/keyword-rules` without retraining. Fast to set up, good
   for validating whether on-screen text actually distinguishes your classes.
2. **Trained text classifier** (`app/ml/text_classifier.py`) — TF-IDF +
   Logistic Regression over OCR'd text, trained automatically alongside the
   CNN in `POST /train` whenever there's enough usable text.
3. **CNN fallback** — if OCR comes back empty/too short, or no text
   model/rules exist for that model, it's CNN-only (identical to before OCR
   fusion existed).

**Performance:** OCR only runs when the CNN's frame-by-frame prediction
*changes* (a candidate scene transition), not on every sampled frame — turning
O(frames) OCR calls into roughly O(scenes). See `_sample_and_classify` in
`app/services/video_pipeline.py`.

**Training report:** `POST /train` now reports test-set metrics for CNN-only,
text-only, *and* the fused combination side by side (`metrics.cnn_only` /
`metrics.text_only` / `metrics.combined` in the training job / model doc) — so
you can see, with numbers, whether OCR fusion actually helped for your data
rather than assuming it did. `text_only`/`combined` are `null` if there wasn't
enough usable OCR text across your training images.

This needs the **Tesseract** OCR engine installed as a system binary (the
Dockerfile already installs it for you): macOS `brew install tesseract`,
Ubuntu/Debian `apt install tesseract-ocr`. `pytesseract` (in `requirements.txt`)
is just the Python wrapper around it.

## Setup

Use **Python 3.11** — the whole ML stack here (`tensorflow`, `opencv-python-headless`, etc.) has the most reliably prebuilt wheels on 3.11. Python 3.14 is too new (no compatible TensorFlow build exists for it yet), and some 3.12 environments have been seen pulling in unbuildable ancient package versions when wheels aren't available for that exact interpreter.

```bash
cd backend
python3.11 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env   # then fill in the values below
```

If `python3.11` isn't installed: `brew install python@3.11` (macOS).

**Apple Silicon (M1/M2/M3) note:** `requirements.txt` installs plain
`tensorflow` (not `tensorflow-macos`) plus `tensorflow-metal` for optional
GPU/Neural Engine acceleration. If your venv was created before this change,
or you ever see a training request fail with `NotFoundError: dlopen(... libmetal_plugin.dylib ...): Library not loaded: @rpath/_pywrap_tensorflow_internal.so`
in the worker terminal, that's `tensorflow-macos` and `tensorflow-metal`
having drifted out of sync — clean up and reinstall:

```bash
pip uninstall -y tensorflow tensorflow-macos tensorflow-metal tf-keras
pip install -r requirements.txt
```

If it still misbehaves, `tensorflow-metal` itself is the fragile part (it's
tied tightly to your macOS/Xcode version) and isn't required — this app's
training workload is a small, frozen-backbone MobileNetV2 head on ~20-25
images per class, which trains in well under a minute on CPU alone. Drop it
entirely with `pip uninstall tensorflow-metal` and training will just run on
CPU.

Fill in `.env`:

- **Firebase**: the web-app config values (`FIREBASE_*`) are mostly for the
  Next.js frontend, but `FIREBASE_PROJECT_ID` is also read directly by the
  backend (Firestore access). For the *backend* to verify tokens and use
  Firestore, you additionally need a **service account key**: Firebase
  Console → Project Settings → Service Accounts → Generate new private key →
  save the JSON as `backend/firebase-service-account.json` and make sure
  `GOOGLE_APPLICATION_CREDENTIALS` in `.env` points at it. Without this, the
  API still starts, but any auth-protected endpoint returns `503`.
- **Cloud Storage**: `GCS_BUCKET_NAME` — a standalone GCS bucket, NOT
  Firebase Storage; see "Cloud Storage setup" above for creating the bucket,
  granting the same service account access to it, and configuring CORS.
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

| Method | Path                            | Purpose                                                                                                                 |
| ------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                     | Liveness + whether Firebase is configured                                                                               |
| POST   | `/users/bootstrap`            | Create/refresh the caller's Firestore profile (role defaults to "user")                                                 |
| GET    | `/users/me`                   | Current user's profile, including role                                                                                  |
| POST   | `/uploads/signed-url`         | Get a short-lived signed URL to PUT a video/training-image directly to Cloud Storage                                    |
| POST   | `/jobs`                       | Register an already-uploaded-to-Cloud-Storage video and enqueue processing                                              |
| GET    | `/jobs` / `/jobs/{id}`      | List / check status of your jobs                                                                                        |
| DELETE | `/jobs/{id}`                  | Best-effort cancel (only while still queued)                                                                            |
| GET    | `/logs/{job_id}`              | Scene rows as JSON                                                                                                      |
| GET    | `/logs/{job_id}/csv`          | Same data as a downloadable CSV                                                                                         |
| POST   | `/logs/combine`               | Merge several jobs' logs into one CSV                                                                                   |
| GET    | `/models` / `/models/{id}`  | Model registry                                                                                                          |
| POST   | `/models`                     | Manually register an externally-trained model (e.g. from Teachable Machine)                                             |
| PATCH  | `/models/{id}/activate`       | Set the default model for new jobs                                                                                      |
| PATCH  | `/models/{id}/keyword-rules`  | Update the OCR keyword-override rules without retraining                                                                |
| POST   | `/train`                      | Kick off the in-app training pipeline (MobileNetV2 + OCR text classifier + fusion, full test-set metrics for all three) |
| GET    | `/train` / `/train/{id}`    | List your training jobs (most recent first) / check one job's status + metrics report                                   |
| POST   | `/train/{id}/retry`           | Re-run a failed (or stuck-queued) job with the exact same dataset — no re-upload needed                                |
| POST   | `/analytics/spm`              | Sequential Pattern Mining across a set of videos                                                                        |
| POST   | `/analytics/dsm`              | Differential Sequence Mining between two groups of videos                                                               |
| POST   | `/admin/cleanup-stale-videos` | **Admin only.** Safety-net cleanup for orphaned Cloud Storage video blobs                                         |
| GET    | `/admin/users`                | **Admin only.** List all user profiles                                                                            |
| PATCH  | `/admin/users/{uid}/role`     | **Admin only.** Promote/demote a user                                                                             |
| GET    | `/admin/stats`                | **Admin only.** System-wide counts for the admin dashboard                                                        |

All endpoints except `/health` require `Authorization: Bearer <Firebase ID token>`; `/admin/*` additionally requires `role: "admin"` in Firestore.

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
  so a job with no `model_id` behaves exactly like the current Streamlit app —
  CNN-only, no text fusion (it has no keyword rules or text model attached).
- The text classifier is TF-IDF + Logistic Regression, not a transformer —
  deliberately lightweight given how small/formulaic screen-recording UI text
  usually is. If it proves insufficient, `app/ml/text_classifier.py` is the
  place to swap in something heavier.
- Region-of-interest OCR cropping (`ocr_roi` on a model doc) is supported by
  the classifier but has no dedicated API endpoint yet — set it directly on
  the Firestore doc for now if you know your UI's header position.
