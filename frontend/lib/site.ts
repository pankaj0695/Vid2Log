import type { Metadata } from "next";

// Single source of truth for the deployed site's absolute URL — used by
// metadataBase (layout.tsx), sitemap.ts, robots.ts, and JSON-LD so there's
// only one place to update once this is actually deployed to a real domain.
//
// IMPORTANT: set NEXT_PUBLIC_SITE_URL to the real production URL (e.g.
// https://vid2log.yourdomain.com) in your production environment. Without
// it, absolute URLs generated for Open Graph/Twitter previews, canonical
// links, and the sitemap will fall back to localhost and be wrong once
// deployed — search engines and social-media unfurlers need the real,
// public URL, not http://localhost:3000.
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000").replace(/\/$/, "");

export const SITE_NAME = "vid2log";
export const SITE_DESCRIPTION =
  "Train an image classifier on your app's screens and automatically turn screen-recording videos into structured, timestamped activity logs — with real test-set metrics, CNN+OCR fusion, and built-in sequential/differential pattern mining.";

// Applied via each signed-in route's own segment layout.tsx. These pages
// require auth (ProtectedRoute redirects a signed-out visitor — and a
// crawler — straight to /login) and show nothing but a spinner or another
// user's private data, so there's no public content here worth indexing.
// See app/robots.ts for why this is a meta tag and not a robots.txt
// Disallow.
export const NOINDEX_METADATA: Metadata = {
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
};
