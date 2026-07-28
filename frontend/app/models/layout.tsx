import type { Metadata } from "next";
import { NOINDEX_METADATA } from "@/lib/site";

// Covers /models (registry) and /models/[id] (detail). See
// app/dashboard/layout.tsx for why this file exists and why noindex.
export const metadata: Metadata = {
  title: "Models",
  ...NOINDEX_METADATA,
};

export default function ModelsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
