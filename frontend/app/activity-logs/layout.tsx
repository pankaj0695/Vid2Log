import type { Metadata } from "next";
import { NOINDEX_METADATA } from "@/lib/site";

// See app/dashboard/layout.tsx for why this file exists and why noindex.
export const metadata: Metadata = {
  title: "Activity logs",
  ...NOINDEX_METADATA,
};

export default function ActivityLogsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
