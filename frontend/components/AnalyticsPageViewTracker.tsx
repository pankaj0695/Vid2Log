"use client";

import { Suspense, useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { trackPageView } from "@/lib/firebase-analytics";

function PageViewTrackerInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    const query = searchParams.toString();
    const pagePath = query ? `${pathname}?${query}` : pathname;
    trackPageView(pagePath, document.title);
    // `searchParams` (not just `pathname`) is a dep so this also re-fires on
    // query-only navigations — e.g. tab switches that use `?tab=...` rather
    // than a full route change, which `pathname` alone wouldn't catch.
  }, [pathname, searchParams]);

  return null;
}

// Mounted once in the root layout so every route change — including
// client-side App Router navigations, which GA4's own automatic page_view
// can't see — gets logged. Wrapped in Suspense because useSearchParams()
// requires it (Next.js opts the whole enclosing tree out of static
// rendering otherwise); scoping that de-opt to just this tiny tracker keeps
// the rest of the app statically rendered.
export function AnalyticsPageViewTracker() {
  return (
    <Suspense fallback={null}>
      <PageViewTrackerInner />
    </Suspense>
  );
}
