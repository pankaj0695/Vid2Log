import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hides the on-screen dev route indicator (the floating icon bottom-left
  // during `next dev`) — purely cosmetic dev-mode chrome, doesn't affect
  // build/runtime error overlays, which still show regardless.
  devIndicators: false,
  // Emits a self-contained `.next/standalone` build (server + only the node_modules
  // it actually needs) instead of requiring a full `npm install` in the
  // runtime image — this is what keeps the Cloud Run container image small
  // and fast to start. See frontend/Dockerfile. No effect on `next dev`.
  output: "standalone",
};

export default nextConfig;
