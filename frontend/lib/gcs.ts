"use client";

// Direct-to-Cloud-Storage upload, straight from the browser — the
// video/image bytes never pass through our backend. Cloud Storage here is a
// STANDALONE GCS bucket, not Firebase Storage (Firebase Storage requires the
// whole project to be on the Blaze billing plan; a plain GCS bucket does
// not), so there's no client-side Storage SDK involved at all. Instead:
//   1. Ask the backend for a short-lived signed PUT URL, scoped to this
//      user's own uid-prefixed path (POST /uploads/signed-url — see
//      backend/app/routers/uploads.py).
//   2. PUT the raw file bytes straight to that URL via XHR (fetch doesn't
//      expose upload progress events, which the "N/N images uploaded"
//      progress bar on the training page needs).
import { api } from "./api";

export type GCSUploadKind = "training-uploads" | "video-uploads";

// Public kind names (kept as-is so app/train/page.tsx and
// app/process/page.tsx don't need to change) map to the backend's own
// closed allow-list of upload kinds (see routers/uploads.py::_KIND_PREFIXES).
const BACKEND_KIND: Record<GCSUploadKind, string> = {
  "training-uploads": "training-image",
  "video-uploads": "video",
};

export interface GCSUploadResult {
  /** Blob path within the bucket — this is what the backend stores and
   * later reads back via its own service-account-credentialed client (see
   * backend/app/services/gcs_service.py). There is deliberately no public
   * URL: nothing but our own backend ever needs to read these files back. */
  storage_path: string;
}

// Bucket configuration (GCS_BUCKET_NAME) lives entirely on the backend now —
// there's no frontend env var to synchronously check anymore. Kept as a
// no-op for backward compatibility with existing call sites; if the backend
// isn't configured, the signed-url request below fails with a clear 503
// surfaced as a normal ApiError instead.
export function isStorageConfigured(): boolean {
  return true;
}

function putWithProgress(url: string, file: File, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload to Cloud Storage failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Upload to Cloud Storage failed (network error)."));
    xhr.send(file);
  });
}

export async function uploadToGCS(
  file: File,
  kind: GCSUploadKind,
  onProgress?: (fraction: number) => void
): Promise<GCSUploadResult> {
  // content_type must match exactly what we PUT with below — GCS validates
  // the signature against it.
  const contentType = file.type || "application/octet-stream";
  const { upload_url, storage_path } = await api.uploads.signedUrl({
    filename: file.name,
    content_type: contentType,
    kind: BACKEND_KIND[kind],
  });
  await putWithProgress(upload_url, file, onProgress);
  return { storage_path };
}

/** Uploads several files in sequence, reporting overall fraction complete
 * across the whole batch (used for the "N/N images uploaded" progress bar
 * on the training page). Sequential (not parallel) to keep the UI's
 * per-file progress readable and avoid hammering the browser with dozens of
 * simultaneous uploads for a 20-25 image class. */
export async function uploadManyToGCS(
  files: File[],
  kind: GCSUploadKind,
  onOverallProgress?: (fraction: number, doneCount: number) => void
): Promise<GCSUploadResult[]> {
  const results: GCSUploadResult[] = [];
  for (let i = 0; i < files.length; i++) {
    const result = await uploadToGCS(files[i], kind, (fileFraction) => {
      const overall = (i + fileFraction) / files.length;
      onOverallProgress?.(overall, i);
    });
    results.push(result);
    onOverallProgress?.((i + 1) / files.length, i + 1);
  }
  return results;
}
