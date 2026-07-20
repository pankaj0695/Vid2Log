"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { Container } from "@/components/ui/Section";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, HelpText } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { GoogleIcon } from "@/components/GoogleIcon";

function SignupForm() {
  const { firebaseUser, loading, signUpWithEmail, signInWithGoogle } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  useEffect(() => {
    if (!loading && firebaseUser) router.replace(next);
  }, [loading, firebaseUser, next, router]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError("Please enter your name.");
      return;
    }
    setSubmitting(true);
    try {
      await signUpWithEmail(email, password, name);
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setGoogleLoading(true);
    try {
      await signInWithGoogle();
      router.replace(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign up with Google.");
    } finally {
      setGoogleLoading(false);
    }
  }

  return (
    <Container className="flex min-h-[calc(100vh-4rem)] items-center justify-center py-16">
      <Card className="w-full max-w-md">
        <h1 className="text-2xl font-semibold text-text">Create your account</h1>
        <p className="mt-1 text-sm text-neutral-600">
          New accounts start with standard access — every log stays private to you.
        </p>

        <div className="mt-6 space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}

          <Button type="button" variant="outline" className="w-full" onClick={handleGoogle} loading={googleLoading}>
            <GoogleIcon />
            Continue with Google
          </Button>

          <div className="flex items-center gap-3 text-sm text-neutral-400">
            <span className="h-px flex-1 bg-neutral-200" />
            or
            <span className="h-px flex-1 bg-neutral-200" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="name">Full name</Label>
              <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                minLength={6}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <HelpText>At least 6 characters.</HelpText>
            </div>
            <Button type="submit" className="w-full" loading={submitting}>
              Create account
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-neutral-600">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Log in
          </Link>
        </p>
      </Card>
    </Container>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
