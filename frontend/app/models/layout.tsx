import type { Metadata } from "next";
import { NOINDEX_METADATA } from "@/lib/site";

// Covers /models/[id] (there's no /models index page). See
// app/dashboard/layout.tsx for why this file exists and why noindex.
export const metadata: Metadata = {
  title: "Model details",
  ...NOINDEX_METADATA,
};

export default function ModelsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
