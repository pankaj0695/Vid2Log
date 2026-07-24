import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// Only the three routes that are actually public and have unique content
// for a crawler to index — everything else (/dashboard, /train, /process,
// /analytics, /admin, /models/[id]) sits behind auth, redirects an
// unauthenticated visitor (and a crawler) straight to /login, and is
// explicitly noindex'd in its own segment layout.tsx. Listing those here
// would just be asking Google to spend crawl budget on a login redirect.
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    {
      url: `${SITE_URL}/`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${SITE_URL}/signup`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/login`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.3,
    },
  ];
}
