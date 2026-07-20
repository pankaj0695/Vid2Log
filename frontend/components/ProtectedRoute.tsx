"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { Spinner } from "./ui/Spinner";

/** Wrap any page that requires sign-in. Redirects to /login while
 * preserving the intended destination via `next`. Pass `adminOnly` for
 * pages that additionally require role="admin" (e.g. /admin). */
export function ProtectedRoute({
  children,
  adminOnly = false,
}: {
  children: React.ReactNode;
  adminOnly?: boolean;
}) {
  const { firebaseUser, profile, isAdmin, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!firebaseUser) {
      router.replace(`/login?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    if (adminOnly && profile && !isAdmin) {
      router.replace("/dashboard");
    }
  }, [loading, firebaseUser, profile, isAdmin, adminOnly, router]);

  if (loading || !firebaseUser || (adminOnly && !isAdmin)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner label="Checking your session..." />
      </div>
    );
  }

  return <>{children}</>;
}
