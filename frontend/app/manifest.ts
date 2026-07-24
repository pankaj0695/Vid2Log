import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

// Next.js serves this at /manifest.webmanifest automatically and links it
// from <head>. A web app manifest isn't a direct Google ranking factor, but
// it's part of the mobile-friendliness/PWA signals search engines and
// social platforms use, and it's what makes "Add to Home Screen" show the
// right name/icon/theme instead of a bare URL.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} — Screen recordings to activity logs`,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: "#070c13",
    theme_color: "#070c13",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
