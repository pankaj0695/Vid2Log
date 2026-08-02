# Deploying vid2log to GCP (Cloud Run)

This is the step-by-step path from a working local setup (see `backend/README.md`
and the root `README.md`) to a running production deployment, entirely on
Google Cloud. Everything runs on **Cloud Run** — three separate deployables:

| Local piece                          | Becomes on GCP                                   |
| ------------------------------------- | ------------------------------------------------- |
| `uvicorn app.main:app` (API)          | Cloud Run **service** (`vid2log-api`)             |
| `python -m app.worker` (RQ worker)    | Cloud Run **worker pool** (`vid2log-worker`)      |
| `npm run start` (Next.js)             | Cloud Run **service** (`vid2log-frontend`)        |
| `docker run redis:7-alpine`           | **Memorystore for Redis**                         |
| Firebase project (already exists)     | unchanged — same project                          |
| GCS bucket (already exists)           | unchanged — same bucket, see `backend/README.md`  |

Cloud Run resources are **not** reachable to Memorystore's private network by
default, so both the API service and the worker pool need their own path
into the VPC — but via two *different* mechanisms, since worker pools don't
support the same one regular Cloud Run services do: the API service (a
regular Cloud Run service) uses a **Serverless VPC Access connector**
(`--vpc-connector`); the worker pool uses **Direct VPC egress**
(`--network`/`--subnet`) instead — see steps 3, 6, and 7. The frontend and
backend only talk to each other over the public internet (frontend calls the
backend's HTTPS URL), so no VPC access of any kind is needed for that leg.

Every code change this required (Cloud Run `$PORT` handling, signed-URL
generation without a downloaded key file, the missing `pytesseract`
dependency, the frontend's standalone Docker build) is already done — see
"Code changes already made" at the bottom. This guide is what's left: GCP-side
setup and the actual deploy commands.

---

## 0. Prerequisites

- A GCP project with billing enabled (the same project your Firebase project
  already uses — Firebase Console → Project Settings shows the project ID).
- [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) installed and
  authenticated: `gcloud auth login && gcloud config set project YOUR_PROJECT_ID`.
- Docker installed locally (for building images) — or skip local Docker
  entirely and use `gcloud builds submit`, which builds in the cloud instead;
  every `docker build` step below has that as a drop-in alternative.
- The Firebase service-account JSON key and GCS bucket already set up per
  `backend/README.md` ("Cloud Storage setup") — this guide assumes that part
  is done.

Set some shell variables you'll reuse for the rest of this guide:

```bash
export PROJECT_ID=your-project-id
export REGION=us-central1        # pick any Cloud Run region
gcloud config set project $PROJECT_ID
```

---

## 1. Enable required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  redis.googleapis.com \
  vpcaccess.googleapis.com \
  iam.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  storage.googleapis.com
```

## 2. Create an Artifact Registry repo

Both Docker images (backend, frontend) get pushed here.

```bash
gcloud artifacts repositories create vid2log \
  --repository-format=docker \
  --location=$REGION \
  --description="vid2log container images"

gcloud auth configure-docker $REGION-docker.pkg.dev
```

## 3. Memorystore Redis + VPC connector

Memorystore instances are only reachable from inside a VPC, so Cloud Run
needs a **Serverless VPC Access connector** to reach it.

```bash
# Redis instance (Basic tier is fine for a single RQ queue; no HA)
gcloud redis instances create vid2log-redis \
  --size=1 \
  --region=$REGION \
  --redis-version=redis_7_0

# Note the private IP it comes up with
gcloud redis instances describe vid2log-redis --region=$REGION --format="value(host)"

# VPC connector in the same region, on the default network
gcloud compute networks vpc-access connectors create vid2log-connector \
  --region=$REGION \
  --network=default \
  --range=10.8.0.0/28
```

Build the Redis URL from the IP the `describe` command printed:

```bash
export REDIS_URL="redis://REDIS_IP:6379/0"
```

## 4. Service account + IAM roles

Reuse the same service account already used for `GOOGLE_APPLICATION_CREDENTIALS`
locally (Firebase Console → Project Settings → Service Accounts — the
`client_email` in that JSON key). On Cloud Run you **attach** this account to
each service/worker pool instead of shipping the JSON key file inside the
container image, which is both simpler and more secure (nothing to leak if
the image is ever exposed).

```bash
export SA_EMAIL=firebase-adminsdk-xxxxx@$PROJECT_ID.iam.gserviceaccount.com
```

Grant it everything it needs:

```bash
# Firestore read/write (Firebase Admin SDK)
gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/datastore.user"

# Cloud Storage — already granted per backend/README.md, but shown here for
# completeness (Storage Object Admin, scoped to the bucket):
gcloud storage buckets add-iam-policy-binding gs://YOUR_BUCKET_NAME \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/storage.objectAdmin"

# REQUIRED, NEW: lets this account sign GCS URLs on its own behalf via the
# IAM SignBlob API. Without a downloaded JSON key file, Cloud Run's attached
# service-account credentials have no private key to sign with locally —
# gcs_service.py routes around that by impersonating this same account,
# which only works if it holds Token Creator on itself. Skipping this step
# makes POST /uploads/signed-url fail with a 500 the first time anyone
# tries to upload a video or training image.
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/iam.serviceAccountTokenCreator"
```

## 5. Build and push the backend image

**Cloud Run only runs `linux/amd64` images.** If you're building on an Apple
Silicon Mac, plain `docker build` produces an `arm64` image by default, which
will fail to deploy (or fail this same step even harder, since packages like
`hdbscan` don't ship prebuilt `arm64` wheels and need a C compiler to build
from source). Two ways around this — pick one:

**Option A (recommended): let Cloud Build do it.** Cloud Build's default
workers are `amd64`, so this sidesteps the architecture question entirely and
is usually faster than a local build + push over your home connection:

```bash
cd backend
gcloud builds submit --tag $REGION-docker.pkg.dev/$PROJECT_ID/vid2log/backend:latest .
```

**Option B: build locally, forcing the platform:**

```bash
cd backend
docker build --platform linux/amd64 -t $REGION-docker.pkg.dev/$PROJECT_ID/vid2log/backend:latest .
docker push $REGION-docker.pkg.dev/$PROJECT_ID/vid2log/backend:latest
```

(If you're on Intel/amd64 hardware already, `--platform linux/amd64` is a
no-op — safe to include either way.)

## 6. Deploy the backend API as a Cloud Run service

```bash
gcloud run deploy vid2log-api \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/vid2log/backend:latest \
  --region=$REGION \
  --service-account=$SA_EMAIL \
  --vpc-connector=vid2log-connector \
  --vpc-egress=private-ranges-only \
  --allow-unauthenticated \
  --memory=2Gi \
  --cpu=2 \
  --set-env-vars="REDIS_URL=$REDIS_URL,GCS_BUCKET_NAME=YOUR_BUCKET_NAME,FIREBASE_PROJECT_ID=$PROJECT_ID,CORS_ORIGINS=http://localhost:3000,APP_ENV=production"
```

Notes:
- `--allow-unauthenticated` because the app already does its own auth (Firebase
  ID tokens, checked per-request) — Cloud Run's own IAM auth layer would be
  redundant and would block the frontend's browser calls.
- No `GOOGLE_APPLICATION_CREDENTIALS` env var is set — leaving it unset makes
  `firebase_service.py` and `gcs_service.py` both fall through to Application
  Default Credentials, i.e. the attached `--service-account` above. This is
  the path the code changes in this session specifically enabled.
- `CORS_ORIGINS` is set to a placeholder for now — you don't know the
  frontend's real Cloud Run URL yet. Come back to step 9 and update it once
  the frontend is deployed.
- `--memory=2Gi --cpu=2` is a starting point — TensorFlow + PyTorch +
  OpenCV all loading in-process want headroom; raise it if you see OOM kills
  in `gcloud run services logs read vid2log-api`.

Note the URL it prints (`https://vid2log-api-xxxxx.a.run.app`) — the frontend
needs it.

## 7. Deploy the RQ worker as a Cloud Run worker pool

The worker isn't an HTTP server — it long-polls Redis — so it doesn't fit
Cloud Run's request-driven service model or Cloud Run Jobs' run-to-completion
model. **Worker pools** (GA since April 2026) are built for exactly this: a
long-running, non-HTTP process that Cloud Run keeps alive and can scale on
queue depth.

**Worker pools use a different VPC mechanism than regular Cloud Run
services** — Direct VPC egress (`--network`/`--subnet`) instead of a
Serverless VPC Access connector, so `--vpc-connector` (used for the API
service in step 6) isn't a valid flag here. `--network=default` /
`--subnet=default` assumes the project's default auto-mode VPC network,
which auto-creates a `default` subnet in every region — the same underlying
network `vid2log-connector` sits on, just reached without a connector
resource in the middle.

```bash
gcloud beta run worker-pools deploy vid2log-worker \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/vid2log/backend:latest \
  --command="python" \
  --args="-m,app.worker" \
  --region=$REGION \
  --service-account=$SA_EMAIL \
  --network=default \
  --subnet=default \
  --vpc-egress=private-ranges-only \
  --instances=1 \
  --memory=4Gi \
  --cpu=4 \
  --set-env-vars="REDIS_URL=$REDIS_URL,GCS_BUCKET_NAME=YOUR_BUCKET_NAME,FIREBASE_PROJECT_ID=$PROJECT_ID"
```

(`gcloud beta run worker-pools` may have graduated to `gcloud run worker-pools`
without the `beta` prefix by the time you run this — try both if one errors
with "unrecognized command".)

Notes:
- Same image as the API (`backend/Dockerfile`'s default `CMD` is overridden
  here to run `python -m app.worker` instead of `uvicorn`) — one image,
  two deployables, exactly like `docker-compose.yml` does locally with `api`
  and `worker` sharing a build but different `command:`.
- `--instances=1` is **manual, fixed scaling** — unlike the API service,
  this does NOT scale to zero, ever, even with no jobs queued. Worker pools
  aren't request-triggered, so with 0 instances nothing would ever be
  running to dequeue a job in the first place — this is an always-on cost,
  not an autoscaling minimum. Raise it (or move to queue-depth-based
  autoscaling once you have real traffic) if jobs back up.
- `--memory=4Gi --cpu=4` — the worker is where TensorFlow/PyTorch/OpenCV
  actually run inference, not just import; give it more headroom than the API.
- No `--allow-unauthenticated` / no public URL at all — worker pools aren't
  reachable from outside GCP, which is correct here; nothing should ever call
  it directly.

## 8. Build, push, and deploy the frontend

The frontend needs its `NEXT_PUBLIC_*` values baked in **at build time** (see
`frontend/Dockerfile`) — pass them as `--build-arg`s, not as Cloud Run runtime
env vars, which have no effect on already-compiled client JS. Same `amd64`
caveat as step 5 applies — `--platform linux/amd64` below is required if
you're building locally on Apple Silicon.

```bash
cd ../frontend
docker build --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_FIREBASE_API_KEY=... \
  --build-arg NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=... \
  --build-arg NEXT_PUBLIC_FIREBASE_PROJECT_ID=$PROJECT_ID \
  --build-arg NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=... \
  --build-arg NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=... \
  --build-arg NEXT_PUBLIC_FIREBASE_APP_ID=... \
  --build-arg NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=... \
  --build-arg NEXT_PUBLIC_API_BASE_URL=https://vid2log-api-xxxxx.a.run.app \
  --build-arg NEXT_PUBLIC_SITE_URL=https://vid2log-frontend-xxxxx.a.run.app \
  -t $REGION-docker.pkg.dev/$PROJECT_ID/vid2log/frontend:latest .

docker push $REGION-docker.pkg.dev/$PROJECT_ID/vid2log/frontend:latest

gcloud run deploy vid2log-frontend \
  --image=$REGION-docker.pkg.dev/$PROJECT_ID/vid2log/frontend:latest \
  --region=$REGION \
  --allow-unauthenticated \
  --memory=512Mi \
  --cpu=1
```

`NEXT_PUBLIC_API_BASE_URL` needs the backend's URL from step 6, and
`NEXT_PUBLIC_SITE_URL` needs the frontend's own URL — which you don't have
until after the first deploy. First deploy with a placeholder, note the real
URL Cloud Run assigns, then rebuild once with the correct value (or attach a
custom domain up front — see step 10 — so the URL is stable before you ever
build).

## 9. Close the loop: update backend CORS

Now that the frontend has a real URL, update the backend so its CORS
middleware actually accepts requests from it:

```bash
gcloud run services update vid2log-api \
  --region=$REGION \
  --update-env-vars="CORS_ORIGINS=https://vid2log-frontend-xxxxx.a.run.app"
```

## 10. (Optional) Custom domain

```bash
gcloud beta run domain-mappings create \
  --service=vid2log-frontend \
  --domain=your-domain.com \
  --region=$REGION
```

Same for the backend on a subdomain (e.g. `api.your-domain.com`) if you want
a stable API URL — then `NEXT_PUBLIC_API_BASE_URL` and `CORS_ORIGINS` above
can point at the permanent domains instead of the auto-generated `*.a.run.app`
URLs, so you never have to rebuild/redeploy either side again just because a
URL changed.

## 11. (Optional) Cloud Scheduler for the stale-upload cleanup job

`POST /admin/cleanup-stale-videos` and `POST /admin/cleanup-stale-action-previews`
(see `backend/README.md`) are safety nets meant to run on a schedule — but
both require `Authorization: Bearer <Firebase ID token>` from an account with
`role: "admin"` in Firestore, not just a GCP-level credential, so a plain
Cloud Scheduler HTTP target with OIDC auth (Cloud Scheduler's usual pattern
for hitting Cloud Run) **won't** satisfy this by itself — OIDC gives Cloud Run
a GCP service-account identity, not a Firebase user identity.

The simplest working setup: a small script (run anywhere with your admin
Firebase credentials — a tiny Cloud Function works, or even a one-off Cloud
Scheduler → Pub/Sub → Cloud Function chain) that mints a Firebase custom
token for a designated admin UID via the Admin SDK, exchanges it for an ID
token via the [Identity Toolkit REST API](https://cloud.google.com/identity-platform/docs/reference/rest/v1/accounts/signInWithCustomToken),
then calls the endpoint with that token. This is optional — the app works
fine without it; stale uploads just sit in the bucket a bit longer than
`older_than_hours` until someone calls the endpoint by hand.

---

## Code changes already made

These were required for the app to actually work correctly on Cloud Run —
already committed, not something you need to do:

- **`backend/app/services/gcs_service.py`** — signed URL generation (used by
  `POST /uploads/signed-url`) now falls back to IAM SignBlob-based
  impersonated credentials when no JSON key file is present, instead of
  crashing with "you need a private key to sign credentials". This is what
  step 4's `roles/iam.serviceAccountTokenCreator` grant is for.
- **`backend/requirements.txt`** — added `pytesseract`, which `app/ml/ocr.py`
  imports unconditionally but was missing entirely; a fresh build would have
  crashed the worker on its first OCR call.
- **`backend/Dockerfile`** — `CMD` now reads Cloud Run's injected `$PORT`
  instead of a hardcoded `8000`. Also added `build-essential` (gcc/g++/make),
  which `hdbscan` needs to compile its C extensions on platforms without a
  prebuilt wheel (e.g. `linux/arm64`) — without it, the image fails to build
  with `error: command 'gcc' failed: No such file or directory`. Note this
  doesn't remove the need to build for `linux/amd64` when deploying — Cloud
  Run doesn't run `arm64` images at all, so an Apple Silicon Mac still needs
  `docker build --platform linux/amd64` or `gcloud builds submit` (see
  step 5) even with the compiler installed.
- **`frontend/next.config.ts`** — `output: "standalone"` for a minimal,
  fast-starting Cloud Run image.
- **`frontend/Dockerfile`**, **`frontend/.dockerignore`** — new multi-stage
  build producing that standalone image, with every `NEXT_PUBLIC_*` value
  wired through as a build arg.
- **`frontend/package.json`** / **`frontend/package-lock.json`** — kept in
  sync with each other; the lockfile is committed as-is, so `frontend/Dockerfile`'s
  `npm ci` (which needs an exactly-matching lockfile) works without a manual
  `npm install` step.
