// DEPRECATED — superseded by lib/gcs.ts.
//
// vid2log migrated off Cloudinary to Google Cloud Storage (via the Firebase
// Storage client SDK) because Cloudinary's free plan caps raw-file uploads
// at 10MB, which trained model files routinely exceed. Nothing imports this
// module anymore — see lib/gcs.ts (uploadToGCS / uploadManyToGCS), which
// train/page.tsx and process/page.tsx now use instead.
//
// This file is left in place (rather than deleted) only because the
// migration was applied in a sandboxed environment that couldn't delete
// files from the mounted project folder — it's safe to delete by hand once
// you've confirmed the app runs correctly without it.
export {};
