import type { Metadata } from "next";

// Unlike the signed-in app routes, /login stays indexable (inherits the
// root layout's default index/follow robots) — it's a legitimate public
// entry point people search for directly (e.g. "vid2log login"), just with
// its own title/description instead of the site-wide default.
export const metadata: Metadata = {
  title: "Log in",
  description: "Log in to vid2log with email/password or Google.",
  alternates: { canonical: "/login" },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
