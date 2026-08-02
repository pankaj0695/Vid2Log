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

## SEO

- `lib/site.ts` — single source of truth for `SITE_URL`/`SITE_NAME`/
  `SITE_DESCRIPTION` and the shared `NOINDEX_METADATA` object. Set
  `NEXT_PUBLIC_SITE_URL` to the real production URL once deployed (see
  `.env.local.example`) — everything below depends on it being correct.
- `app/layout.tsx` — full metadata (Open Graph, Twitter card, keywords,
  icons, `metadataBase`) plus site-wide Organization JSON-LD.
- `app/page.tsx` additionally carries its own `SoftwareApplication` JSON-LD.
- `app/opengraph-image.png` — static 1200×630 social-share card (a real
  product screenshot, not generated), used automatically for every route
  that doesn't define its own.
- `app/sitemap.ts` / `app/robots.ts` — the sitemap only lists `/`, `/login`,
  `/signup` (the only actually-public routes with unique content).
- Every signed-in route (`/dashboard`, `/train`, `/process`, `/analytics`,
  `/admin`, `/models/[id]`) has its own `layout.tsx` purely to attach
  `NOINDEX_METADATA` — those pages are Client Components (can't export
  `metadata` themselves) and have nothing public to show a crawler anyway
  (`ProtectedRoute` redirects a signed-out visitor to `/login`). `/login`
  and `/signup` get their own `layout.tsx` too, but stay indexable with
  page-specific titles/descriptions.

## Notes

- Firestore is never touched directly from the browser — every read/write
  goes through the FastAPI backend (Admin SDK), so there are no Firestore
  security rules to maintain here and a client can never forge its own role.
- Job and training-job status pages poll the backend on an interval rather
  than using websockets — simple and sufficient at this scale; swap in
  Firestore realtime listeners or SSE later if job volume grows.
