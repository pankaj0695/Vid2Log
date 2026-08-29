# Vid2Log: Design, Implementation, and Deployment of an AI-Powered Video-to-Action-Log Platform

### A Technical Report on the Cloud Web Application and the Offline Desktop Application

---

## Abstract

Vid2Log is a system that converts screen-recording videos into structured, timestamped action logs using a hybrid convolutional-neural-network and optical-character-recognition (CNN + OCR) classifier. The project began as a single-machine Streamlit prototype built around a manually trained Teachable Machine model and evolved into two independent, production-grade deliverables that share the same core machine-learning logic: a multi-tenant cloud web application (Next.js frontend, FastAPI backend, deployed entirely on Google Cloud Platform) and an offline-first desktop application (a Flutter shell embedding a local Python "sidecar" process) for users who require full data privacy or work without reliable connectivity. Both deliverables support the same core workflow — video upload, automated scene classification, in-app model training with real held-out test metrics, unsupervised action discovery, and sequence-mining analytics (Sequential Pattern Mining and Differential Sequence Mining) — while using entirely different, platform-appropriate infrastructure underneath: Firestore/Cloud Storage/Redis on the web side, and SQLite/local filesystem on the desktop side. This report documents the architecture, machine-learning pipeline, implementation details, and deployment process for both applications, along with the significant engineering problems encountered and solved along the way, including a Cloud Run cost-optimization redesign that replaced an always-on worker pool with an event-triggered, scale-to-zero job.

---

## 1. Introduction

Reviewing screen-recording video manually to produce a structured log of what a user did — which screen they were on, when they transitioned to another screen, what action they took — is slow and error-prone at any meaningful scale. The original approach used for this problem was a Streamlit application: a single video was processed locally against a CNN model trained externally via Google's Teachable Machine, with no persistence, no multi-user support, and no analytics beyond the raw log itself.

This project began as a ground-up rebuild of that workflow, with three goals: first, replace the external Teachable-Machine dependency with an in-app training pipeline that reports genuine test-set metrics rather than assumed accuracy; second, move from a single-user local script to a properly authenticated, multi-tenant web application capable of processing many videos in parallel; and third, once the cloud version was stable, produce a fully offline desktop counterpart for users who cannot or do not want to send video data to a third-party cloud service, or who need the tool to work without an internet connection at all.

<br>

> **[Insert screenshot: Vid2Log landing page]**

<br>

---

## 2. System Overview

Vid2Log exists as two independently deployable applications that intentionally share the same machine-learning behaviour:

- **The cloud web application** — a Next.js frontend and a FastAPI backend, both deployed on Google Cloud Run, backed by Firebase Authentication, Firestore, a standalone Google Cloud Storage bucket, and a Redis-backed job queue. Designed for multiple concurrent users, each with their own videos, models, and datasets.
- **The desktop application** — a Flutter shell for macOS and Windows that spawns a local Python FastAPI process (referred to throughout this report as the "sidecar") on `127.0.0.1` only. Every cloud dependency in the web backend has a local equivalent here: SQLite in place of Firestore, the local filesystem in place of Cloud Storage, and no queueing layer at all, since the desktop app is single-user and processes jobs synchronously.

Both applications implement the identical CNN + OCR hybrid classification pipeline, the same unsupervised action-discovery algorithm, and the same sequence-mining analytics engine, so that a model trained on one platform's data behaves predictably if the same workflow is followed on the other.

---

## 3. Web Application Architecture

### 3.1 Frontend (Next.js)

The frontend is a TypeScript Next.js application using the App Router, built around a custom dark/light "dithered" design system with hand-built SVG chart primitives rather than a heavyweight charting library. It is organised into a sidebar/topbar shell wrapping the following pages: Dashboard (overview, models, and activity tabs), Process Video (submit new jobs, job history), Video Logs, Train (train a new model, view training jobs, model registry), Models (registry and per-model detail pages with retrain support), Create Actions (unsupervised action discovery and manual dataset curation), Analytics (Overview, SPM, DSM, and Video Timeline tabs), and an Admin dashboard for user-role management.

Authentication is handled by Firebase Authentication (email/password); every API call from the frontend attaches the user's Firebase ID token, which the backend verifies independently on each request rather than trusting any client-supplied identity. Public-facing routes (the landing page) carry full SEO metadata — Open Graph and Twitter card tags, JSON-LD structured data, a generated sitemap and robots file — while authenticated application routes are explicitly marked `noindex`. Firebase Analytics instruments page views, authentication events, and key product funnel events (job submission, training completion, and so on) throughout the app.

<br>

> **[Insert screenshot: Web app dashboard]**

<br>

### 3.2 Backend (FastAPI)

The backend is a FastAPI service (`vid2log-api`) that is deliberately kept lightweight: it never imports TensorFlow, PyTorch, or any other heavy ML dependency in the request-handling process itself. Authentication is verified via the Firebase Admin SDK, application data lives in Firestore, and file storage is a standalone Google Cloud Storage bucket — explicitly not Firebase Storage, since Firebase Storage requires the whole project to be on the paid Blaze billing plan, whereas a plain GCS bucket does not.

Uploads never pass through the API server. The frontend requests a short-lived, V4 signed PUT URL scoped to a path under the requesting user's own UID (`POST /uploads/signed-url`), then uploads the raw video or training image bytes directly to Cloud Storage from the browser. Once a background worker has finished processing a video or a training run, the corresponding blob is deleted — videos are never stored permanently, and only small durable artifacts persist: scene logs in Firestore and trained model files (`.h5` / `.joblib`) in Cloud Storage under `models/{model_id}/`. Failed training runs are the one exception: their training images are deliberately kept so that a retry (`POST /train/{id}/retry`) can re-enqueue the exact same dataset without asking the user to re-upload.

Background work is dispatched through Redis using the RQ (Redis Queue) library, across three named queues — `video_processing`, `training`, and `action_discovery` — each with its own timeout and a bounded automatic retry policy for transient failures (network blips, brief DNS issues) that is deliberately narrow enough not to mask genuine bugs. Jobs are enqueued by dotted string reference to the function that will process them, rather than a direct function import, specifically so the lightweight API process is never forced to import the same heavy ML dependencies that the worker needs.

A server-side role system (bootstrap, user, admin) gates administrative endpoints — user management, stale-upload cleanup — independently of Firebase's own authentication layer.

<br>

> **[Insert screenshot: Process video / job history page]**

<br>

### 3.3 Machine Learning Pipeline

**CNN classification.** The core classifier is a MobileNetV2 transfer-learning model: a frozen pretrained backbone with a small trained classification head, which keeps training fast (well under a minute on CPU alone for a typical 20–25-images-per-class dataset) and avoids the need for GPU infrastructure for routine use. Models are saved and loaded via `tf_keras` (legacy Keras 2 API) rather than the Keras 3 API that recent TensorFlow versions default to, specifically to remain compatible with older models originally trained via Google's Teachable Machine export format.

**OCR and text fusion.** Screen-recording frames from different application screens frequently look visually near-identical to a CNN even when they represent genuinely different states — the actual distinguishing signal is very often the on-screen text. The hybrid classifier therefore runs three tiers, in order: a fuzzy-matched, hand-maintained keyword-rule list per class (editable at any time without retraining); a trained TF-IDF plus Logistic Regression text classifier trained automatically alongside the CNN whenever there is enough usable OCR text; and a CNN-only fallback when OCR text is empty, too short, or no text model exists yet for that class. For performance, OCR is run only when the CNN's frame-by-frame prediction changes — i.e. only on candidate scene-transition frames — turning what would be an O(frames) OCR cost into roughly O(scenes). Every training run reports test-set metrics for the CNN-only, text-only, and fused-combination classifiers side by side, so the actual measured benefit of OCR fusion is visible rather than assumed.

**Unsupervised action discovery.** Rather than requiring a user to hand-label every action class from scratch, the Create Actions feature can propose action groupings automatically from raw video frames: MobileNetV2 embeddings are computed for sampled frames, clustered using scikit-learn's built-in HDBSCAN implementation, diversified via greedy farthest-point sampling so the review set isn't dominated by near-duplicate frames, and any resulting noise points are reassigned to their nearest real cluster. The user then reviews, merges, splits, and relabels the proposed clusters in the UI before saving a labelled action dataset.

**Sequence-mining analytics.** Two complementary analyses are available once logs exist across one or more videos: Sequential Pattern Mining (SPM), a gap- and window-constrained, PrefixSpan-style algorithm reporting both instance-support and sequence-support for recurring action patterns; and Differential Sequence Mining (DSM), which compares two user-selected groups of logs for statistically significant differences in action-sequence frequency via SciPy statistical tests. Both are exposed with CSV export and a combined PDF/CSV report generator on the Analytics Overview tab, alongside a per-video, per-action colour-coded timeline.

<br>

> **[Insert screenshot: Analytics — SPM / DSM results]**

<br>

### 3.4 Data Model and Job Lifecycle

Application state lives in Firestore across a small number of collections — `jobs`, `training_jobs`, `discovery_jobs`, `models`, `action_datasets`, and user/role records. The lifecycle of a video job is: signed-URL upload to Cloud Storage, `POST /jobs` referencing the uploaded `storage_path`, enqueue onto the `video_processing` Redis queue, a worker downloads the blob, runs the classification pipeline, writes the resulting scene log to Firestore, and finally deletes both its local temporary copy and the Cloud Storage blob. Training jobs follow the same signed-upload pattern per training image, with the one deliberate exception described above for failed runs.

---

## 4. Desktop (Offline) Application Architecture

### 4.1 Motivation

The desktop application exists for users who cannot or should not send video content to a third-party cloud — regulated environments, users without reliable connectivity, or simply a preference for fully local data ownership — while still getting the same automated classification, training, and analytics workflow as the web application.

### 4.2 Architecture

The desktop app is a Flutter shell (macOS and Windows) that spawns a local Python process — the "sidecar" — built with the same FastAPI framework as the cloud backend, but bound exclusively to `127.0.0.1`, with no external network access required at all once installed. Every cloud dependency the web backend relies on is replaced with a local equivalent:

- Firestore is replaced by a raw SQLite database (`jobs`, `training_jobs`, `discovery_jobs`, and `action_datasets` tables, with the same JSON-column conventions as the Firestore documents they mirror).
- Cloud Storage is replaced by the local filesystem, under `~/.vid2log/` — trained models, saved action datasets, discovery temp files, and the sidecar's own log file all live there, deliberately outside the installed application bundle (see Section 5).
- Redis/RQ queueing is not needed at all: the desktop app is single-user, so video and training jobs are processed synchronously against local compute rather than dispatched to a shared worker pool.
- Firebase Authentication is not needed: there is exactly one local user, and no login step.

### 4.3 Feature Parity

The desktop application ports every core feature of the web app: video processing with scene-log generation, in-app model training with genuine train/validation/test metrics, a local model registry, the Create Actions workflow (including unsupervised discovery, an image lightbox for previewing any saved image, drag-and-drop to move an image from one action to another, and a right-hand management panel matching the web app's layout for merging and adding actions), CSV log import as an alternative to processing a raw video, and the complete four-tab Analytics page (Overview, SPM, DSM, and Video Timeline). Two specific correctness issues were addressed during this port: the Differential Sequence Mining tab now prevents the same log from being selected in both comparison groups at the UI level, and the video timeline's colour assignment was rewritten to assign colours by index over a stable, sorted list of every action label rather than by hashing action names — the previous hash-based approach could, and did, collide two different actions onto the same displayed colour.

### 4.4 Startup Reliability

Because TensorFlow's own import is the dominant cost in the sidecar's startup time (several seconds), an early version of the app exhibited a race condition: any screen whose first API call fired before the sidecar had finished starting would surface a raw connection error, even though the app worked correctly once the user had navigated between pages a few times. This was resolved with a `waitUntilReady()` completer on the Flutter side, resolved only once the sidecar's health check succeeds, which every screen's first API call is now gated on.

<br>

> **[Insert screenshot: Desktop app — home / sidebar]**

<br>

> **[Insert screenshot: Desktop app — Create Actions screen]**

<br>

> **[Insert screenshot: Desktop app — Analytics screen]**

<br>

---

## 5. Packaging and Distribution (Desktop)

Shipping the desktop app means freezing a full Python + TensorFlow + OpenCV + scikit-learn + Tesseract environment into something an end user can install with no Python, pip, or virtual environment of their own. This is done with PyInstaller, in one-directory (not one-file) mode specifically to avoid the slow per-launch re-extraction that a one-file build would impose on a bundle this large. A dedicated `app/bundle.py` module resolves resource paths (the default model, the bundled Tesseract binary and its `tessdata` directory) identically whether the code is running from source during development or from inside a frozen bundle, so the rest of the codebase does not need to know which mode it is running in.

The end-to-end release process is: freeze the sidecar with PyInstaller into a standalone executable with the default model and Tesseract OCR bundled inside it; build the Flutter application itself (`flutter build macos` or `flutter build windows`); copy the frozen sidecar into the app bundle (`Contents/Resources/` on macOS, alongside the executable on Windows — the Flutter side's `sidecar_service.dart` prefers this bundled copy over any development virtual environment it finds); and finally package the result as a `.dmg` on macOS or an Inno Setup `.exe` installer on Windows, with a portable `.zip` produced instead if Inno Setup is not available at build time. Neither PyInstaller nor Flutter's desktop tooling supports cross-compilation, so a macOS build must be produced on macOS and a Windows build on Windows.

On macOS, distributing outside of a handful of colleagues requires code signing (`codesign`) with a paid Apple Developer account and notarization via `xcrun notarytool`, since an unsigned app is reported by Gatekeeper as "damaged" — a misleading message that really means unsigned, not corrupted. On Windows, an unsigned installer triggers a SmartScreen warning on first run, avoidable only with a paid code-signing certificate; for internal or research distribution this is typically not worth the cost.

The application's identity was renamed from Flutter's scaffold default (`vid2log`) to `Vid2Log` across the macOS bundle configuration, the Windows executable's embedded metadata, and the window title, and a custom app icon was generated from the product's own logo. That icon generation deliberately pads the source artwork to roughly 80% of a 1024×1024 canvas — matching Apple's own icon template — since a logo that fills its canvas edge-to-edge renders visibly larger than every neighbouring app icon in the Dock and Finder even at identical file dimensions. The final installed application occupies roughly 1.5–2.5 GB, almost entirely accounted for by TensorFlow; this is treated as an inherent cost of shipping a local ML runtime rather than requiring the end user to install a multi-gigabyte Python dependency tree themselves.

<br>

> **[Insert screenshot: macOS app icon in Finder / Dock, alongside other apps]**

<br>

> **[Insert screenshot: Windows installer]**

<br>

---

## 6. Cloud Deployment (Google Cloud Platform)

### 6.1 Infrastructure Overview

The web application runs entirely on Google Cloud Run, split into three deployables built from the same container images: `vid2log-api` (a request-driven Cloud Run **service** that autoscales to zero when idle), `vid2log-frontend` (a Cloud Run **service** serving the Next.js standalone production build), and a background worker responsible for actually executing queued video-processing, training, and action-discovery jobs. Supporting infrastructure consists of Memorystore for Redis (the RQ broker, reachable only from inside the project's VPC), an Artifact Registry repository holding both container images, the pre-existing Firebase project (Authentication and Firestore), a standalone GCS bucket, and a single IAM service account shared between the API and worker with least-privilege role bindings: Firestore read/write, Storage Object Admin scoped to the application's bucket, and — specifically required because Cloud Run's attached service-account credentials have no private key of their own to sign with locally — Token Creator on itself, so it can generate the signed upload URLs described in Section 3.2 by impersonating itself through the IAM SignBlob API.

### 6.2 Reaching Redis from Cloud Run

Memorystore Redis is only reachable from inside the project's VPC, and Cloud Run resources are not on that network by default. The API service, a standard Cloud Run service, reaches it through a Serverless VPC Access connector. The background worker, discussed next, reaches it through Direct VPC egress instead, since that resource type does not support the connector-based mechanism.

### 6.3 Cost Optimization: From an Always-On Worker Pool to Scale-to-Zero Jobs

The background worker was originally deployed as a Cloud Run **worker pool** — a resource type built for long-lived, continuously-running, non-HTTP processes, such as the RQ worker here, which normally blocks indefinitely waiting for new Redis queue entries. Worker pools use a fixed or manually set instance count rather than autoscaling to zero, because with zero running instances there would be nothing available to notice new work in the first place. In practice this meant the worker billed continuously, twenty-four hours a day, regardless of whether any video was actually being processed — an appropriate trade-off for genuinely constant load, but a poor one for intermittent, on-demand usage.

This was redesigned around Cloud Run **Jobs**, a run-to-completion resource type with no such floor: an execution starts, does its work, exits, and billing stops the moment it does. The RQ worker script gained a `--burst` flag, under which it processes everything currently sitting in its queues and then exits cleanly, rather than blocking forever. The API process's queue-enqueue functions were extended so that every time a video, training, or action-discovery job is enqueued to Redis, they also issue a fire-and-forget call to the Cloud Run Admin API's job-execution endpoint, which starts a fresh execution of the worker job. That execution connects to the same Memorystore Redis instance over the same Direct VPC egress networking the worker pool previously used, drains whatever is currently queued using RQ's ordinary atomic dequeue semantics — which makes it safe for more than one execution to be running concurrently without ever double-processing the same job — and exits. The net effect is that the worker now bills close to zero on idle days, while still gaining natural horizontal parallelism whenever multiple jobs are submitted in quick succession, since each triggers its own concurrent execution rather than relying on a single fixed-size worker pool.

### 6.4 Deployment Procedure Summary

The full deployment path — captured as a repeatable runbook in the project's `DEPLOYMENT.md` — is: enable the required GCP APIs (Cloud Run, Artifact Registry, Memorystore, Serverless VPC Access, IAM, Cloud Build, Firestore, Cloud Storage); create the Artifact Registry repository; provision the Memorystore Redis instance and its VPC connector; grant the shared service account its IAM roles; build and push both container images via Cloud Build (which builds for `linux/amd64` by default, sidestepping the architecture mismatch that plain local Docker builds hit on Apple Silicon); deploy the API and frontend as Cloud Run services; deploy the worker as a Cloud Run Job and grant the API service account permission to trigger its executions; close the loop by updating the API's CORS configuration once the frontend's real Cloud Run URL is known; and, optionally, attach a custom domain and configure Cloud Scheduler for periodic maintenance endpoints such as stale-upload cleanup.

<br>

> **[Insert screenshot: GCP Cloud Run console — deployed services and job]**

<br>

---

## 7. Engineering Challenges and Solutions

A number of non-obvious problems surfaced during development and deployment; the more significant ones are recorded here since they materially shaped the final architecture.

**Keras 2 vs. Keras 3 serialization.** TensorFlow versions from 2.16 onward bundle Keras 3 and alias `tf.keras` to it by default, while the classifier deliberately loads models via the separate legacy `tf_keras` package for compatibility with older Teachable-Machine-exported models. Left unaddressed, this caused newly trained models to be saved in a format the loader could not read, surfacing as an `Unrecognized keyword arguments: ['batch_shape']` error the first time a video job tried to use a freshly trained model. The fix forces legacy Keras 2 behaviour at the earliest possible point in the process (via the `TF_USE_LEGACY_KERAS` environment variable) for all future saves, combined with a fallback loader that catches the specific error and retries under the Keras 3 API for any model trained before the fix existed — avoiding forcing existing users to retrain.

**PyInstaller's static-analysis blind spots.** Freezing the sidecar initially failed because `uvicorn.run("app.main:app")` passes its target as a string, resolved by `importlib` only at runtime — invisible to PyInstaller's static import-graph analysis, which consequently omitted the entire `app` package from the frozen bundle. The fix was to import the FastAPI app object directly and pass the object itself to `uvicorn.run()`. A related failure came from excluding `numpy.f2py` from the bundle to save size, not realising that SciPy's `array_api_compat` module walks every attribute of the numpy package at runtime — removing that submodule from the exclusion list resolved a `ModuleNotFoundError` that only appeared once the bundle was actually run, not at build time.

**Diagnosing a silent packaged-app crash.** A Finder-launched GUI application has no attached terminal, so a Python traceback in the sidecar process was, at first, entirely invisible — the app could report only a bare exit code. This was resolved by having the desktop shell capture the sidecar's stdout/stderr into a persistent log file (`~/.vid2log/sidecar.log`) in addition to a rolling in-memory tail surfaced directly in the error banner. A related, initially confusing case was a sidecar that failed to bind its port because a previous launch's process was still holding it — the app now checks for and adopts an already-healthy sidecar on startup instead of blindly attempting to spawn a duplicate, which both fixed the immediate issue and made the underlying failure mode self-correcting going forward.

**Cloud cost optimization.** Covered in full in Section 6.3: migrating the background worker from an always-on Cloud Run worker pool to an event-triggered, burst-mode Cloud Run Job eliminated the fixed 24/7 billing floor without changing the underlying Redis/RQ job model at all.

---

## 8. Current Status

Both applications are functional end-to-end. The cloud web application is deployed on Google Cloud Platform with signed-URL uploads, background job processing now running on scale-to-zero Cloud Run Jobs, role-based administration, and the full analytics suite. The desktop application has been built and verified as an installable `.dmg` on macOS, with the equivalent Windows `.exe` build path fully scripted and documented, pending verification on physical Windows hardware. Feature parity between the two deliverables covers the entire core workflow: video processing, in-app training with real test metrics, action discovery, and sequence-mining analytics.

---

## 9. Conclusion and Future Work

Vid2Log demonstrates that a single, carefully layered machine-learning pipeline — CNN classification, OCR text fusion, unsupervised action discovery, and sequence-mining analytics — can serve two structurally very different deployment targets, a multi-tenant cloud SaaS application and a single-user offline desktop application, without diverging in behaviour, by isolating every cloud-specific dependency (Firestore, Cloud Storage, Redis, Firebase Auth) behind interfaces that have straightforward local equivalents (SQLite, the filesystem, synchronous processing, no auth layer). Planned future work includes evaluating GPU-backed Cloud Run Jobs for faster training on larger datasets, completing verification of the Windows installer on physical hardware, obtaining code-signing certificates for both platforms to remove the current Gatekeeper/SmartScreen friction for end users, and investigating a move from TensorFlow to ONNX Runtime for the desktop build specifically to reduce its current 1.5–2.5 GB installed footprint.

---

_End of report._
