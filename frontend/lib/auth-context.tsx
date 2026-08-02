"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createUserWithEmailAndPassword,
  getAdditionalUserInfo,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { auth, googleProvider } from "./firebase";
import { api, ApiError } from "./api";
import { identifyUser, trackEvent } from "./firebase-analytics";
import type { UserProfile } from "./types";

interface AuthContextValue {
  firebaseUser: User | null;
  profile: UserProfile | null;
  loading: boolean;
  isAdmin: boolean;
  signUpWithEmail: (email: string, password: string, displayName: string) => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function friendlyAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code || "";
  const map: Record<string, string> = {
    "auth/email-already-in-use": "An account with this email already exists. Try signing in instead.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
    "auth/popup-closed-by-user": "Sign-in was cancelled.",
    "auth/network-request-failed": "Network error — check your connection and try again.",
  };
  return map[code] || (err instanceof Error ? err.message : "Something went wrong. Please try again.");
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const syncProfile = useCallback(async (displayNameHint?: string | null) => {
    try {
      const p = await api.users.bootstrap(displayNameHint ?? undefined);
      setProfile(p);
    } catch (err) {
      // Backend not reachable / not configured yet — don't block the whole
      // app on this, just leave role at the safe default so admin-only UI
      // stays hidden until the profile call actually succeeds.
      console.error("Failed to sync user profile:", err);
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setFirebaseUser(user);
      // Ties every subsequent GA4 event to this user (or clears the tie on
      // sign-out) — covers page refreshes and already-signed-in sessions,
      // not just the explicit sign-in/sign-up calls below.
      identifyUser(user?.uid ?? null);
      if (user) {
        await syncProfile(user.displayName);
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, [syncProfile]);

  // Separate from the identifyUser() call above: `profile` (and its role)
  // only resolves after syncProfile()'s own async round-trip, so this fires
  // slightly later and layers the "role" GA4 user property on top of the
  // uid that's already been set.
  useEffect(() => {
    if (firebaseUser && profile) {
      identifyUser(firebaseUser.uid, { role: profile.role });
    }
  }, [firebaseUser, profile]);

  const signUpWithEmail = useCallback(async (email: string, password: string, displayName: string) => {
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (displayName.trim()) {
        await updateProfile(cred.user, { displayName: displayName.trim() });
      }
      await syncProfile(displayName.trim() || null);
      // "sign_up" is one of GA4's recommended event names — using it (with
      // the right `method` param) instead of a made-up one gets automatic
      // funnel/retention reporting in the Firebase/GA4 console for free.
      trackEvent("sign_up", { method: "password" });
    } catch (err) {
      throw new Error(friendlyAuthError(err));
    }
  }, [syncProfile]);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      trackEvent("login", { method: "password" });
    } catch (err) {
      throw new Error(friendlyAuthError(err));
    }
  }, []);

  const signInWithGoogle = useCallback(async () => {
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      // Google sign-in creates the account on first use — there's no
      // separate "sign up with Google" button — so `isNewUser` is what
      // actually distinguishes a new signup from a returning login here.
      const isNewUser = getAdditionalUserInfo(cred)?.isNewUser ?? false;
      trackEvent(isNewUser ? "sign_up" : "login", { method: "google" });
    } catch (err) {
      throw new Error(friendlyAuthError(err));
    }
  }, []);

  const logout = useCallback(async () => {
    trackEvent("logout");
    await signOut(auth);
  }, []);

  const refreshProfile = useCallback(async () => {
    try {
      const p = await api.users.me();
      setProfile(p);
    } catch (err) {
      if (!(err instanceof ApiError)) console.error(err);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      firebaseUser,
      profile,
      loading,
      isAdmin: profile?.role === "admin",
      signUpWithEmail,
      signInWithEmail,
      signInWithGoogle,
      logout,
      refreshProfile,
    }),
    [firebaseUser, profile, loading, signUpWithEmail, signInWithEmail, signInWithGoogle, logout, refreshProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
