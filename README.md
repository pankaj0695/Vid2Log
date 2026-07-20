# vid2log 2.0 — Platform Architecture & Delivery Plan

**One platform, replacing a two-tool manual workflow (Teachable Machine ➜ PDF instructions ➜ single-video Streamlit script) with a multi-user, API-driven system for training, batch log generation, and behavioral analytics.**

---

## 1. Executive Summary

Today, producing one activity log requires: training a model by hand on Teachable Machine (no test-set metrics), manually placing the exported `.h5` file into a repo, and running one video at a time through a Streamlit script. vid2log 2.0 replaces this with a single application that trains models with proper evaluation, processes videos in parallel at scale, and turns the resulting logs into decision-ready analytics — accessible to multiple users through a real UI and a public API.

|               | Today                                  | vid2log 2.0                                                       |
| ------------- | -------------------------------------- | ----------------------------------------------------------------- |
| Training      | Manual, browser-based, no test metrics | In-app pipeline, full precision/recall/F1/confusion-matrix report |
| Processing    | One video at a time                    | Parallel batch processing, job dashboard                          |
| Output        | Raw CSV per video                      | Visual analytics + Sequential & Differential Pattern Mining       |
| Access        | Single local user, manual scripts      | Multi-user, authenticated, API-accessible                         |
| Model history | Overwritten each retrain               | Versioned registry with lineage                                   |

---

## 2. Target Architecture

```
┌──────────────────────────┐      ┌──────────────────────────────┐
│   Next.js Frontend       │      │      Firebase                │
│  - Dashboard             │◄────►│  - Auth (multi-user, roles)  │
│  - Training UI           │      │  - Firestore (jobs, models,  │
│  - Log Visualizations    │      │    users, scenes, metadata)  │
│  - SPM / DSM Analytics   │      │  - Storage (video/image/     │
│                          │◄────►│    model blobs — GCS)        │
└───────────┬──────────────┘      └──────────────────────────────┘
            │ REST/WebSocket        (direct browser upload via
            ▼                        the Storage client SDK)
┌──────────────────────────┐
│   FastAPI Backend        │
│  - Auth middleware (Firebase Admin SDK)
│  - /train  /jobs  /logs  /analytics  /models
└───────────┬──────────────┘
            ▼
┌─────────────────────────┐      ┌──────────────────────────────┐
│  Job Queue (Redis +     │◄────►│  Worker Pool                 │
│  Celery/RQ)             │      │  - Downloads video from      │
└─────────────────────────┘      │    Cloud Storage, classifies,│
                                 │    saves log, deletes video  │
                                 │  - Model training (transfer  │
                                 │    learning + test metrics)  │
                                 │  - SPM / DSM analysis jobs   │
                                 └──────────────────────────────┘
```

Frontend and backend are decoupled (Next.js ↔ FastAPI over REST), Firebase handles auth and metadata/state, a standalone Cloud Storage bucket handles file storage, and the worker pool scales independently of the API — this is what makes multi-user, parallel, API-first operation possible. Cloud Storage holds files purely as **ephemeral video/image storage plus a durable model store** (see §3.2a) — it is not a general replacement for Firestore. (This used to be Cloudinary; see §3.2a for why it moved.)

---

## 3. Core Modules

### 3.1 Training Module — fixes Teachable Machine's metrics gap

Transfer learning on MobileNetV2, run from the Next.js UI or the API. Stratified train/val/**test** split (not TM's internal 85/15), with a full post-training report: accuracy, per-class precision/recall/F1, confusion matrix, and a misclassified-frame gallery. Every run is logged to the **Model Registry** (§3.4). TM-exported models can still be imported for quick prototyping.

### 3.2 Parallel Processing Engine

Celery/RQ workers pull one video per job from the queue; pool size scales to available CPU cores. Replaces the current sequential `batch_process.py` loop. Job status lives in Firestore, so the dashboard shows live per-video progress across an entire batch instead of one progress bar.

### 3.2a Video Storage Lifecycle (Cloud Storage, temporary only)

**Cloud Storage** — a standalone GCS bucket, deliberately NOT Firebase Storage (which requires the whole Firebase project to be on the pay-as-you-go Blaze plan; a plain GCS bucket does not) — holds videos and training images, but only for the duration of one processing/training job, never permanently:

1. The frontend asks the backend for a short-lived **signed upload URL** (`POST /uploads/signed-url`), scoped to the current user's own uid-prefixed path, then `PUT`s the video directly to Cloud Storage with it (no API secret, and no raw bytes, ever touch our own server).
2. The frontend calls `POST /jobs` with the resulting blob path only — the backend never receives raw video bytes.
3. A worker downloads the video from Cloud Storage to local disk (via the backend's own service-account credentials — no public URL involved), classifies it, and writes the resulting scene log to Firestore (the durable output).
4. The worker deletes its local copy (always, even on error) and then **deletes the blob from Cloud Storage** once the log is safely saved.
5. A scheduled cleanup job (cron / Cloud Scheduler hitting `POST /admin/cleanup-stale-videos`) is a safety net that reclaims any video a crashed worker failed to delete.

Only two things persist long-term: trained `.h5`/`.joblib` model files and, optionally, exported reports — both tiny compared to raw video, keeping storage cost close to zero. (This was Cloudinary through the first build-out; it moved to Cloud Storage because Cloudinary's free plan caps raw-file uploads at 10MB, which trained models exceed. A standalone GCS bucket — rather than Firebase Storage — keeps this on Cloud Storage's own free tier for light usage, rather than requiring the whole project to be upgraded to Firebase's Blaze plan.)

### 3.3 Unified Dashboard (Next.js)

Batch upload, live job status, and one-click chaining of scene refinement + log merging (formalizing today's separate `scene_refine.py` / `combine_logs.py` scripts) — plus the visualization and analytics views below.

### 3.4 Model Registry

Every trained model stored with its dataset version, hyperparameters, and test-set metrics, queryable via API — so any generated log can be traced back to the exact model that produced it, and model versions can be compared over time.

### 3.5 Multi-User Support & Auth

Firebase Authentication (email/Google/institute SSO) with role-based access (admin / analyst / viewer) enforced in FastAPI via the Firebase Admin SDK. Firestore security rules provide a second layer of access control on the data itself.

### 3.6 API Layer (FastAPI)

Every capability — training, batch submission, log retrieval, analytics — exposed as a documented REST endpoint (OpenAPI/Swagger, generated automatically by FastAPI), so the platform can be driven headlessly or integrated into other IITB tools, not just through the dashboard.

### 3.7 Monitoring

Job success/failure rates, processing-time trends, and model-confidence drift over time, surfaced as a dashboard panel — early warning if a video source or model version starts degrading.

### 3.8 Log Visualization

Per-video timelines (Gantt-style activity strip), time-per-class breakdowns (bar/pie), and cross-video/cohort rollups — built from the existing `combine_logs.py` output, now rendered interactively instead of opened as a CSV.

### 3.9 Log Analytics — Sequential & Differential Pattern Mining

- **Sequential Pattern Mining (SPM):** mines each activity log (and the combined cohort dataset) for frequent activity subsequences — e.g., which class-to-class transitions or multi-step sequences recur most often — surfacing common workflows, loops, and rework patterns. Implemented with a standard SPM algorithm (PrefixSpan/GSP via `prefixspan`/`spmf`), run as an async worker job and cached in Firestore.
- **Differential Sequence Mining (DSM):** compares sequence patterns *between groups* (e.g., high- vs. low-performing sessions, or before/after a process change) to surface which patterns are distinctively over- or under-represented in one group — turning raw logs into a "what actually differs between good and struggling sessions" answer, not just a single-video summary.

Both run as background jobs (same worker pool as video processing) and results are pushed to the dashboard as ranked pattern lists and comparison views.

---

## 4. Technology Stack

| Layer              | Choice                                          | Why                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend           | Next.js                                         | Server-rendered dashboard, good fit for data-heavy visualization pages                                                                                                                                               |
| Backend API        | FastAPI                                         | Async, auto-generated OpenAPI docs, native fit for ML inference/training endpoints                                                                                                                                   |
| Auth               | Firebase Auth                                   | Managed, multi-provider, minimal setup                                                                                                                                                                               |
| Database           | Firestore                                       | Managed, scales with usage, holds job status / model registry / user & analytics metadata                                                                                                                            |
| File storage       | Cloud Storage (standalone GCS bucket)           | **Temporary** video/training-image storage via backend-issued signed upload URLs (deleted right after processing) + **permanent** `.h5`/`.joblib` model storage. Same GCP project and service-account credentials as Firestore, but NOT Firebase-managed Storage (avoids requiring the Blaze billing plan). |
| Job queue          | Redis + Celery/RQ                               | Decouples upload from processing; enables parallel workers                                                                                                                                                           |
| Training/inference | TensorFlow/Keras (MobileNetV2)                  | Compatible with existing`.h5` model contract, CPU-sufficient                                                                                                                                                       |
| Pattern mining     | PrefixSpan/GSP-based SPM, custom DSM comparator | Standard, well-understood sequence-mining approach                                                                                                                                                                   |
| Containerization   | Docker / docker-compose                         | Identical deploy on GCP or an IIT Bombay server                                                                                                                                                                      |

---

## 5. Server Requirements

Inference and training here are both CPU-feasible at this model size (2.4 MB MobileNet, small datasets, transfer learning only) — GPU is a nice-to-have for training speed, not a requirement (see prior discussion). Sizing is driven by **video storage and concurrent job count**, not model compute.

| Scale               | vCPU   | RAM   | GPU                                    | Storage                                |
| ------------------- | ------ | ----- | -------------------------------------- | -------------------------------------- |
| Pilot / single team | 4–8   | 16 GB | Optional                               | 100–250 GB SSD + object storage       |
| Department-wide     | 16–32 | 64 GB | Optional (T4/L4, training bursts only) | 500 GB–1 TB SSD + bulk object storage |

---

## 6. Deployment Options

**GCP (recommended default):**

- Frontend + FastAPI backend on **Cloud Run** (CPU-only, scales to zero when idle).
- Workers as **Cloud Run Jobs** (add an L4 GPU only if/when training volume justifies it).
- Firebase Auth + Firestore, plus a standalone Cloud Storage bucket for files — all within the same GCP project, minimal extra integration work, no Blaze billing plan requirement.
- Redis via **Memorystore** (or a small self-managed instance for cost).

**IIT Bombay server:**

- Viable for hosting the FastAPI backend, workers, and Redis/Postgres if compute/storage is available in-house — reduces cloud spend for the always-on components.
- **Firebase Auth/Firestore/Storage remain externally-hosted managed services regardless of where the app runs** — confirm the IIT server has outbound internet access before committing to this path.
- Confirm with the Computer Centre (cc.iitb.ac.in, ext. 2677): available compute/storage quota, whether it supports an always-on service (vs. batch-only HPC jobs), and network egress policy.
- Good fit as the GPU burst-compute backend for training even if the always-on app stays on GCP.

Both paths use the same Docker images — the choice is a cost/ownership decision, not an architecture one.

---

## 7. Phased Delivery Plan

| Phase | Deliverable                                                                                              | Status                                                                                                             |
| ----- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1     | Firebase (Auth + Firestore + Storage) wired to a FastAPI skeleton and Next.js shell | ✅ Backend skeleton delivered in`backend/` — config, Firebase/Storage/Redis services, all routers, RQ worker |
| 2     | Parallel processing engine (Celery/RQ + workers) replacing sequential batch script                       | ✅ Implemented (`app/services/video_pipeline.py`, `app/worker.py`)                                             |
| 3     | Training module with train/val/test split and full metrics report; Model Registry                        | ✅ First working version (`app/services/training_pipeline.py`) — frozen MobileNetV2, no augmentation yet        |
| 4     | Unified dashboard: batch upload, live job status, log visualization                                      | ⏳ Next.js frontend not yet built                                                                                  |
| 5     | SPM & DSM analytics jobs, surfaced in dashboard                                                          | ✅ API endpoints implemented (`/analytics/spm`, `/analytics/dsm`); dashboard surfacing pending                 |
| 6     | Monitoring panel, role-based multi-user access hardening                                                 | ⏳ Not started                                                                                                     |
| 7     | Deployment (GCP and/or IIT server), Dockerized, documented                                               | ✅ Dockerfile + docker-compose ready; actual deploy pending                                                        |

---

## 8. Open Items

- Expected video volume/length and concurrent-user count — drives storage and worker-pool sizing.
- Whether IIT-B HPC/server access is confirmed and supports an always-on service or batch-only.
- Definition of the group comparison for DSM (e.g., performance tiers, cohorts, before/after) — needed to scope the first analysis.
