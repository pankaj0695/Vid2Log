import type { Metadata } from "next";
import { NOINDEX_METADATA } from "@/lib/site";

// Signed-in only, like every other app-shell route — see app/dashboard/layout.tsx
// for why this file exists and why noindex.
export const metadata: Metadata = {
  title: "Help",
  ...NOINDEX_METADATA,
};

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
