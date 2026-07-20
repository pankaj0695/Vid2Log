"use client";

// Firebase client SDK — Auth only. Firestore is never touched directly from
// the browser: every read/write goes through the FastAPI backend (which uses
// the Admin SDK), so there are no Firestore security rules to maintain here
// and a client can never forge its own role. See backend/README.md "Users
// and roles".
import { getApps, initializeApp, type FirebaseOptions } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

const isConfigured = Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY);

// The Firebase Auth SDK validates `apiKey`'s shape the moment `getAuth()`
// runs, and that call happens at module load time — which Next.js also
// executes during the server-side render of every page (client components
// still render once on the server for the initial HTML). Without a
// well-formed fallback here, an unfilled .env.local doesn't just break
// sign-in at runtime, it hard-crashes `next build` for the whole app with a
// cryptic "auth/invalid-api-key" error. A harmless placeholder keeps the app
// buildable; real sign-in still correctly fails with a clear error until
// .env.local is filled in with real values (see .env.local.example).
if (!isConfigured && typeof window !== "undefined") {
  console.warn(
    "[vid2log] NEXT_PUBLIC_FIREBASE_* env vars are not set — copy .env.local.example to " +
      ".env.local and fill in your Firebase web app config before signing in."
  );
}

const firebaseConfig: FirebaseOptions = isConfigured
  ? {
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
      projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
      storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
      measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
    }
  : {
      apiKey: "unconfigured-placeholder-key",
      authDomain: "unconfigured.firebaseapp.com",
      projectId: "unconfigured",
    };

export const firebaseApp = getApps().length ? getApps()[0]! : initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const googleProvider = new GoogleAuthProvider();
// No Firebase Storage export here — file storage is a standalone GCS
// bucket, accessed only from the backend. The frontend uploads directly to
// it via a signed URL the backend issues (see lib/gcs.ts), never through a
// client-side Storage SDK.
