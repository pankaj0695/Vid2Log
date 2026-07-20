import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hides the on-screen dev route indicator (the floating icon bottom-left
  // during `next dev`) — purely cosmetic dev-mode chrome, doesn't affect
  // build/runtime error overlays, which still show regardless.
  devIndicators: false,
};

export default nextConfig;
