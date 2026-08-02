<div align="center">
  <img src="frontend/public/vid2log-logo.png" alt="vid2log" width="72" height="72" />

  # vid2log

  **Turn screen recordings into structured activity logs, automatically.**

  Train an image classifier on your app's screens, then let vid2log watch any recording and produce a clean, timestamped, analyzable log of what happened, when.

  ![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=next.js&logoColor=white)
  ![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
  ![TensorFlow](https://img.shields.io/badge/TensorFlow-CNN-FF6F00?style=flat-square&logo=tensorflow&logoColor=white)
  ![PyTorch](https://img.shields.io/badge/PyTorch-DINOv2-EE4C2C?style=flat-square&logo=pytorch&logoColor=white)
  ![Firebase](https://img.shields.io/badge/Firebase-Auth-FFCA28?style=flat-square&logo=firebase&logoColor=black)
</div>

---

## What it does

Producing an activity log used to mean training a model by hand with no test-set metrics, and feeding videos through a single-video script one at a time. vid2log replaces that with one application: train a classifier with a real evaluation report, process any number of recordings in parallel, and turn the resulting logs into decision-ready analytics — all through a browser UI backed by a documented API.

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="frontend/public/home.png" alt="Landing page (light)" /><br /><sub>Landing page — light</sub></td>
    <td width="50%"><img src="frontend/public/home-dark.png" alt="Landing page (dark)" /><br /><sub>Landing page — dark</sub></td>
  </tr>
  <tr>
    <td><img src="frontend/public/dashboard.png" alt="Dashboard" /><br /><sub>Dashboard — jobs, models, activity at a glance</sub></td>
    <td><img src="frontend/public/models.png" alt="Model detail" /><br /><sub>Model detail — CNN + OCR fusion metrics</sub></td>
  </tr>
  <tr>
    <td><img src="frontend/public/video-logs.png" alt="Video logs" /><br /><sub>Scene-by-scene video logs</sub></td>
    <td><img src="frontend/public/video-timeline.png" alt="Video timeline" /><br /><sub>Video timeline</sub></td>
  </tr>
  <tr>
    <td colspan="2"><img src="frontend/public/spm.png" alt="Sequential pattern mining" /><br /><sub>Analytics — sequential pattern mining</sub></td>
  </tr>
</table>

## Features

- **CNN + OCR fusion classification** — a TensorFlow CNN classifier fused with Tesseract-based OCR text extraction, so visually near-identical screens still get told apart. Every training run reports CNN-only, OCR-only, and fused metrics side by side.
- **Auto-discover actions** — upload a demo recording and vid2log clusters it into candidate actions automatically (DINOv2 embeddings + HDBSCAN clustering). Review, merge, rename, and drag images between actions before saving a reusable action dataset.
- **Real test-set metrics** — a genuine train/val/test split with accuracy, per-action precision/recall/F1, and a confusion matrix, not just training accuracy.
- **Model registry** — every trained model versioned with its dataset and metrics; compare, activate, retrain, or roll back at any time.
- **Parallel batch processing** — queue any number of recordings; a pool of background workers processes them independently.
- **Scene-by-scene logs** — a timestamped activity log per video with per-scene confidence, viewable in-app, exportable as CSV, or importable from an existing CSV.
- **Pattern mining** — Sequential Pattern Mining (SPM) surfaces common workflows; Differential Sequence Mining (DSM) shows what statistically differs between two groups of sessions.
- **Reporting** — one-click PDF/CSV export of aggregate analytics.
- **Google Drive import** — pick training images or a video straight from Drive instead of a local file.
- **Light/dark theme**, role-based access (user/admin), and a responsive dashboard shell throughout.

## Tech stack

| Layer              | Technology                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| Frontend           | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4              |
| Auth                | Firebase Authentication (email/password + Google)                          |
| Backend API         | FastAPI                                                                     |
| Database            | Firestore — jobs, models, users, action datasets                           |
| File storage        | Standalone Google Cloud Storage bucket via signed uploads (not Firebase Storage) |
| Job queue           | Redis + RQ — separate queues for video processing, training, and action discovery |
| Classification      | TensorFlow / tf-keras (CNN, transfer learning) fused with Tesseract OCR (`pytesseract`) |
| Action discovery    | PyTorch + Transformers (DINOv2 embeddings) + HDBSCAN clustering            |
| Analytics           | scikit-learn, SciPy, pandas — SPM/DSM pattern mining and statistical tests |
| Reporting           | jsPDF                                                                       |

## Architecture

```
Next.js frontend  ──── Firebase Auth (sign-in)
      │
      │ REST, Bearer ID token
      ▼
FastAPI backend ──────────────────────► Firestore (jobs, models, users, datasets)
      │
      ├──► Cloud Storage      (signed uploads: temp video/image blobs, permanent model files)
      │
      └──► Redis ──► RQ workers
                       ├─ video_processing    CNN + OCR classification → scene log
                       ├─ training            fine-tune classifier, report test metrics
                       └─ action_discovery    DINOv2 embeddings + HDBSCAN clustering
```

The frontend never talks to Firestore or Cloud Storage directly — every read/write goes through the FastAPI backend, and files are uploaded straight from the browser to Cloud Storage via short-lived signed URLs (raw bytes never touch the API server). See `backend/README.md` for the full storage lifecycle and why it moved off Firebase Storage.

## Project structure

```
vid2log/
├── frontend/               Next.js app — dashboard, training, analytics UI
├── backend/                FastAPI app, RQ workers, and ML pipelines
├── streamlit_application/  Original single-video prototype this project replaces
└── *.md, *.ipynb           Design docs and the DINOv2/HDBSCAN research notebook
```

## Getting started

**Prerequisites:** Node.js 20+, Python 3.11, Redis, Tesseract OCR, a Firebase project (Auth + Firestore), and a standalone Google Cloud Storage bucket.

```bash
# Backend
cd backend
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env              # fill in Firebase, GCS, and Redis config
python -m uvicorn app.main:app --reload --port 8000   # API on :8000
python -m app.worker                                  # separate terminal — run more for more parallel jobs
```

```bash
# Frontend
cd frontend
npm install
cp .env.local.example .env.local  # fill in Firebase web config + API URL
npm run dev                       # app on :3000
```

Or run the backend with `docker compose up --build` from `backend/`. Full setup details — Firebase project setup, Cloud Storage bucket/CORS/IAM, Google Drive import, and troubleshooting — live in [`backend/README.md`](backend/README.md) and [`frontend/README.md`](frontend/README.md).

## Deployment

Step-by-step instructions for deploying the full stack (API, RQ worker, frontend) to Google Cloud Run, including Memorystore, IAM, and Artifact Registry setup, are in [`DEPLOYMENT.md`](DEPLOYMENT.md).

---

<div align="center">
  <sub>Built for IIT Bombay research & learning-platform video analysis.</sub>
</div>
