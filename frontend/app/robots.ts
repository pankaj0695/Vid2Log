import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Deliberately NOT disallowing /dashboard, /train, /process, /analytics,
// /admin, /models here even though they're private. Google's own guidance
// is explicit about why: a robots.txt Disallow stops crawling entirely, so
// Googlebot never actually fetches the page and never sees a `noindex` meta
// tag placed on it — the two mechanisms conflict when combined. Those
// routes are noindex'd instead via each segment's own layout.tsx (see
// app/dashboard/layout.tsx and siblings), which requires the page to
// actually be crawled once so the tag is seen and honored, then dropped
// from the index and not recrawled. robots.txt here just points crawlers at
// the sitemap; there's nothing worth blocking at the crawl level for a site
// this size.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
