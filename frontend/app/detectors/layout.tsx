import type { Metadata } from "next";
import { NOINDEX_METADATA } from "@/lib/site";

// Covers /detectors (the list) and /detectors/[id] (detail). See
// app/dashboard/layout.tsx for why this file exists and why noindex.
export const metadata: Metadata = {
  title: "My detectors",
  ...NOINDEX_METADATA,
};

export default function DetectorsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
