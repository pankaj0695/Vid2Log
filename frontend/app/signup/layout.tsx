import type { Metadata } from "next";

// See app/login/layout.tsx — same reasoning, stays indexable.
export const metadata: Metadata = {
  title: "Sign up free",
  description: "Create a free vid2log account and start training a classifier for your app's screens.",
  alternates: { canonical: "/signup" },
};

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
