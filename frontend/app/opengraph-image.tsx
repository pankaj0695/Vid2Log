import { ImageResponse } from "next/og";
import { SITE_NAME } from "@/lib/site";

// Next.js picks this file up automatically for every route that doesn't
// define its own opengraph-image, generating the correct og:image (and,
// since no twitter-image file exists, the twitter:image) meta tags with no
// extra wiring needed — this is what a shared link (Slack, iMessage,
// LinkedIn, X) actually renders as the preview card.
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = `${SITE_NAME} — screen recordings to activity logs`;

export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          backgroundColor: "#070c13",
          backgroundImage: "radial-gradient(circle at 78% 22%, rgba(45,212,191,0.18), transparent 55%)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              width: 56,
              height: 56,
              borderRadius: 14,
              backgroundColor: "#2dd4bf",
              color: "#070c13",
              fontSize: 30,
              fontWeight: 700,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            v2l
          </div>
          <div style={{ display: "flex", fontSize: 30, color: "#2dd4bf", fontWeight: 600, letterSpacing: -0.5 }}>
            {SITE_NAME}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 48,
            fontSize: 58,
            fontWeight: 600,
            color: "#eef4f8",
            lineHeight: 1.15,
            maxWidth: 980,
          }}
        >
          Turn screen recordings into activity logs, automatically.
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 28,
            fontSize: 28,
            color: "#9fb0bd",
            maxWidth: 880,
          }}
        >
          Train a classifier, process any recording, and mine the resulting logs for workflows and patterns.
        </div>
      </div>
    ),
    { ...size }
  );
}
