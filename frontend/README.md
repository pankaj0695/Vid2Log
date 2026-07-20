# vid2log frontend (Next.js)

The web app: landing page, Firebase Auth (email/password + Google), model
training, video processing, log viewing, SPM/DSM analytics, and an
admin dashboard. Talks to `backend/` (FastAPI) for everything except
identity — auth is Firebase, everything else goes through the API.

## How it fits together

- **Auth**: Firebase Auth client SDK (`lib/firebase.ts`, `lib/auth-context.tsx`).
  Right after every sign-in/sign-up, `POST /users/bootstrap` creates/refreshes
  the user's Firestore profile — new accounts default to `role: "user"`.
  There is no self-service way to become `role: "admin"`; see
  `backend/README.md` → "Users and roles".
- **API calls**: `lib/api.ts` — a thin fetch wrapper that reads the current
  Firebase ID token and attaches it as `Authorization: Bearer <token>` on
  every request. One typed function per backend endpoint.
- **File uploads**: `lib/gcs.ts` — training images and videos are uploaded
  directly from the browser to a standalone Google Cloud Storage bucket
  (NOT Firebase Storage — see `backend/README.md` → "Cloud Storage setup"
  for why). The flow: call the backend's `POST /uploads/signed-url` (via
  `api.uploads.signedUrl`) to get a short-lived signed PUT URL scoped to the
  current user's own uid-prefixed path, then `PUT` the raw file bytes to
  that URL directly via XHR (for upload-progress events). The backend never
  sees the raw bytes, only the blob path afterward. (This used to be a
  direct-to-Cloudinary unsigned-preset upload; moved to Cloud Storage
  because Cloudinary's free plan caps raw-file uploads at 10MB.)
- **Design system**: `frontend/.agents/skills/design-system/SKILL.md`
  ("dithered") — tokens live in `app/globals.css` as Tailwind v4 `@theme`
  values; reusable primitives are in `components/ui/`.
- **Google Drive import**: `lib/googleDrive.ts` + `components/GoogleDriveImportButton.tsx`
  — an alternative to picking a local file on the training and video-processing
  pages. Downloads the picked file's bytes client-side and hands back a plain
  `File`, so it drops straight into the same Cloud Storage upload path
  (`lib/gcs.ts`) as a local file — the backend can't tell the difference. See
  "Google Drive import setup" below.

## Setup

```bash
cd frontend
npm install
cp .env.local.example .env.local   # then fill in the values below
npm run dev
```

Fill in `.env.local`:

- `NEXT_PUBLIC_FIREBASE_*` — the same Firebase *web app* config values
  documented in `backend/.env.example`. These are not secret; Firebase web
  config is meant to be public. Get them from Firebase Console → Project
  Settings → General → Your apps → SDK setup and configuration. In Firebase
  Console → Authentication → Sign-in method, enable **Email/Password** and
  **Google**. (`NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` is unused by this app —
  file storage is a separate, backend-only GCS bucket; see
  `backend/README.md` → "Cloud Storage setup".)
- `NEXT_PUBLIC_API_BASE_URL` — where `backend/` is running (defaults to
  `http://localhost:8000`).

The app builds and runs even without real Firebase config filled in (it
falls back to a harmless placeholder so `next build` doesn't hard-crash) —
sign-in will just fail with a clear error until you fill in `.env.local`.

Open [http://localhost:3000](http://localhost:3000).

## Google Drive import setup (optional)

Lets users pick training images / a video straight from Google Drive instead
of their local disk. Skip this section entirely if you don't need it — the
"Import from Google Drive" button just doesn't render when unconfigured.

1. In [Google Cloud Console](https://console.cloud.google.com), select the
   same project your Firebase project uses (Firebase projects are backed by
   a GCP project of the same ID — Firebase Console → Project Settings shows
   it).
2. **APIs & Services → Library** — enable **Google Picker API** and
   **Google Drive API**.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   → Application type **Web application**. Add `http://localhost:3000` (and
   your production URL) under **Authorized JavaScript origins**. Copy the
   Client ID into `NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID`.
4. **APIs & Services → Credentials → Create Credentials → API key**. Restrict
   it (Application restrictions → HTTP referrers → add the same origins;
   API restrictions → Google Picker API) and copy it into
   `NEXT_PUBLIC_GOOGLE_DRIVE_API_KEY`.
5. Copy your **project number** (Cloud Console home dashboard, or IAM &
   Admin → Settings) into `NEXT_PUBLIC_GOOGLE_DRIVE_APP_ID`.
6. **APIs & Services → OAuth consent screen → Data Access → Add or remove
   scopes** — filter for "Drive API" and add
   `https://www.googleapis.com/auth/drive.readonly` ("See and download all
   your Google Drive files"). This step is easy to miss and the symptom is
   subtle: the Picker still opens and lets you browse/select files fine, but
   every download afterward fails with `HTTP 403`. If you still hit that
   error after adding the scope here, the improved error message
   (`lib/googleDrive.ts` → `downloadDriveFile`) now includes Google's actual
   reason string, not just the status code — check the browser console for
   specifics (most commonly "Drive API has not been used in project ... or
   it is disabled", meaning step 2 above still needs doing).
7. If your OAuth consent screen is still in **Testing** mode, add the
   Google accounts you'll test with under **Test users** — you already did
   this if Google Sign-In via Firebase works, since it uses the same
   consent screen. `drive.readonly` is a "sensitive" (not "restricted")
   scope, so it works for test users immediately without Google's
   verification review — that review is only required before you publish
   the consent screen for use beyond your test user list.

The button requests `drive.readonly` fresh on demand (only when clicked,
never at login) and the token is never persisted — it's used for that one
picker session plus the immediate downloads, then discarded.

## Pages

| Route        | Access      | Purpose                                                            |
| ------------ | ----------- | ------------------------------------------------------------------- |
| `/`          | Public      | Landing page — what vid2log does and how it works                   |
| `/login`     | Public      | Email/password + Google sign-in                                     |
| `/signup`    | Public      | Email/password (collects name) + Google sign-up                     |
| `/dashboard` | Signed in   | Overview of your jobs and models                                    |
| `/train`     | Signed in   | Create classes, upload ~20–25 images each, train, view test metrics, and see/retry your training job history (a failed job can be retried without re-uploading images) |
| `/process`   | Signed in   | Upload a video, pick a model, view/download logs, combine logs      |
| `/analytics` | Signed in   | Run SPM (frequent patterns) and DSM (differential patterns)         |
| `/admin`     | Admin only  | System stats, user list + role management, stale-video cleanup      |

## Notes

- Firestore is never touched directly from the browser — every read/write
  goes through the FastAPI backend (Admin SDK), so there are no Firestore
  security rules to maintain here and a client can never forge its own role.
- Job and training-job status pages poll the backend on an interval rather
  than using websockets — simple and sufficient at this scale; swap in
  Firestore realtime listeners or SSE later if job volume grows.
