"use client";

// Firebase Analytics (Google Analytics 4 under the hood). Deliberately its
// own module, not folded into lib/firebase.ts — initialization here is
// async and best-effort (see below), unlike Auth's synchronous
// getAuth()/getApp() setup, and every export here is a fire-and-forget
// tracking call rather than something a caller awaits for its return value.
//
// This is intentionally NOT named lib/analytics.ts — api.ts already exports
// `api.analytics` for the product's own SPM/DSM pattern-mining endpoints,
// and reusing the name here would be a confusing collision with a totally
// different "analytics."
import { firebaseApp } from "./firebase";
import type { Analytics } from "firebase/analytics";

type AnalyticsModule = typeof import("firebase/analytics");
interface AnalyticsCtx {
  instance: Analytics;
  mod: AnalyticsModule;
}

let ctxPromise: Promise<AnalyticsCtx | null> | null = null;

// Lazily initializes Firebase Analytics exactly once per page load, and only
// when it's actually usable:
//   - `firebase/analytics` is dynamically imported (not a top-level import)
//     so its module-level code never runs during Next.js's server-side
//     render of this "use client" module — Analytics is a browser-only SDK.
//   - isSupported() is Firebase's own recommended guard: it resolves false
//     in Safari private browsing, when third-party cookies/storage are
//     blocked, or other environments where GA4 silently can't work — see
//     https://firebase.google.com/docs/analytics/get-started?platform=web.
//   - No NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID configured (e.g. a bare-bones
//     local .env.local) means there's nothing to send to — skip entirely
//     rather than let Firebase throw.
// Every exported function below awaits this and no-ops on null, so calling
// any of them anywhere in the app is always safe.
function getAnalyticsCtx(): Promise<AnalyticsCtx | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (!process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID) return Promise.resolve(null);

  if (!ctxPromise) {
    ctxPromise = import("firebase/analytics")
      .then(async (mod) => {
        const supported = await mod.isSupported();
        if (!supported) return null;
        // initializeAnalytics(), not getAnalytics(), specifically so
        // `send_page_view: false` can be passed — otherwise Firebase fires
        // its own automatic page_view the instant this loads, which would
        // double-count against AnalyticsPageViewTracker's explicit
        // trackPageView() calls (including the one for this very page).
        // Every page_view going forward is deliberately manual instead.
        const instance = mod.initializeAnalytics(firebaseApp, { config: { send_page_view: false } });
        return { instance, mod };
      })
      .catch((err) => {
        console.warn("[vid2log] Firebase Analytics failed to initialize:", err);
        return null;
      });
  }
  return ctxPromise;
}

/**
 * Fire-and-forget GA4 event. Safe to call from anywhere (event handlers,
 * effects, api.ts request wrappers) — silently no-ops if analytics isn't
 * configured/supported. Callers should NOT await this for control flow;
 * it exists purely as a side channel.
 */
export function trackEvent(name: string, params?: Record<string, unknown>): void {
  void getAnalyticsCtx().then((ctx) => {
    if (!ctx) return;
    ctx.mod.logEvent(ctx.instance, name, params);
  });
}

/**
 * Ties subsequent events to the signed-in Firebase user (or clears the tie
 * on sign-out via `uid: null`) so GA4's user-scoped reports and funnels
 * reflect real users instead of every session looking anonymous. Optional
 * `properties` sets GA4 user properties (e.g. `{ role: "admin" }`) so
 * dashboards can segment by them without a custom backend export.
 */
export function identifyUser(uid: string | null, properties?: Record<string, string | null>): void {
  void getAnalyticsCtx().then((ctx) => {
    if (!ctx) return;
    ctx.mod.setUserId(ctx.instance, uid);
    if (properties) ctx.mod.setUserProperties(ctx.instance, properties);
  });
}

/**
 * Call once per client-side route change. GA4's usual automatic page_view
 * only fires from the initial gtag.js script load — it has no visibility
 * into Next.js App Router client-side navigations, so without calling this
 * explicitly, every route after the first one a visitor lands on would be
 * invisible in Analytics. See components/AnalyticsPageViewTracker.tsx for
 * where this gets called from.
 */
export function trackPageView(pagePath: string, pageTitle?: string): void {
  trackEvent("page_view", {
    page_path: pagePath,
    page_title: pageTitle,
    page_location: typeof window !== "undefined" ? window.location.href : undefined,
  });
}
