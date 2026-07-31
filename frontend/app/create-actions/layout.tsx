import type { Metadata } from "next";
import { NOINDEX_METADATA } from "@/lib/site";

// See app/dashboard/layout.tsx for why this file exists and why noindex —
// same story here: nothing public to show, this is signed-in app surface.
export const metadata: Metadata = {
  title: "Create actions",
  ...NOINDEX_METADATA,
};

export default function CreateActionsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
