import type { Metadata } from "next";
import { NOINDEX_METADATA } from "@/lib/site";

// Server-component layout that sits next to the "use client" page.tsx in
// this segment purely to carry metadata — Client Components can't export
// `metadata` themselves, but a sibling layout can. See lib/site.ts for why
// this is noindex.
export const metadata: Metadata = {
  title: "Dashboard",
  ...NOINDEX_METADATA,
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
