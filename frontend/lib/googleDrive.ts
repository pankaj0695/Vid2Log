"use client";

// Google Drive import for the training-image and video-upload flows.
// Two separate Google client libraries are involved:
//   1. Google Identity Services (GIS) — gets a short-lived OAuth access
//      token, requested on demand (only when the user actually clicks
//      "Import from Google Drive", never eagerly).
//   2. Google Picker API — the actual file-browsing UI, using that token.
//
// Scope: `drive.readonly`, not the narrower `drive.file`. `drive.file` was
// tried first (it only grants access to files the user explicitly picks,
// which sounds like the perfect least-privilege fit) but its "picking a
// file auto-authorizes it" mechanism turned out to be unreliable in
// practice — the Picker UI works fine, but downloads afterward can still
// 403 depending on exact picker/view configuration. `drive.readonly` is a
// plain, unambiguous standing grant to read whatever the user already has
// access to in Drive for the lifetime of that one access token (~1 hour,
// requested fresh per click, never persisted) — it trades a slightly wider
// scope for actually working reliably.
//
// Requires NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID + NEXT_PUBLIC_GOOGLE_DRIVE_API_KEY
// + NEXT_PUBLIC_GOOGLE_DRIVE_APP_ID, AND the `drive.readonly` scope added
// under your OAuth consent screen's Data Access settings (see
// .env.local.example and README.md "Google Drive import setup"). If the env
// vars are missing, this feature quietly hides itself — see
// isGoogleDriveConfigured() — everything else keeps working.

declare global {
  interface Window {
    // Google's Picker/GIS scripts (loaded dynamically below, no official
    // @types package installed) — genuinely untyped third-party globals,
    // not a case where a real type is being avoided.
    /* eslint-disable @typescript-eslint/no-explicit-any */
    gapi: any;
    google: any;
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }
}

const CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID || "";
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_DRIVE_API_KEY || "";
const APP_ID = process.env.NEXT_PUBLIC_GOOGLE_DRIVE_APP_ID || "";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export function isGoogleDriveConfigured(): boolean {
  return Boolean(CLIENT_ID && API_KEY && APP_ID);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.body.appendChild(script);
  });
}

let scriptsReady: Promise<void> | null = null;

function loadGoogleScripts(): Promise<void> {
  if (!scriptsReady) {
    scriptsReady = Promise.all([
      loadScript("https://accounts.google.com/gsi/client"),
      loadScript("https://apis.google.com/js/api.js"),
    ]).then(
      () =>
        new Promise<void>((resolve, reject) => {
          window.gapi.load("picker", { callback: resolve, onerror: reject });
        })
    );
  }
  return scriptsReady;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return Promise.resolve(cachedToken.token);
  }
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: DRIVE_SCOPE,
      callback: (response: { access_token?: string; expires_in?: number; error?: string; error_description?: string }) => {
        if (!response.access_token) {
          reject(new Error(response.error_description || response.error || "Google Drive authorization failed."));
          return;
        }
        cachedToken = { token: response.access_token, expiresAt: Date.now() + (response.expires_in ?? 3600) * 1000 };
        resolve(response.access_token);
      },
      error_callback: (err: { message?: string; type?: string }) => {
        reject(new Error(err?.type === "popup_closed" ? "Google Drive access was cancelled." : err?.message || "Google Drive authorization failed."));
      },
    });
    client.requestAccessToken({ prompt: "" });
  });
}

interface DrivePickedFile {
  id: string;
  name: string;
  mimeType: string;
}

// google.picker.ViewId.DOCS_IMAGES / DOCS_VIDEOS are flat, search-style
// views (every matching file across all of Drive, no folder tree) — that's
// why the picker showed one long list with no way to browse into a folder.
// Using the general ViewId.DOCS view instead, with folders switched on and
// selection restricted by mime type, gives the normal "My Drive" browsing
// experience: navigate into folders, but only images/videos are pickable.
const IMAGE_MIME_TYPES =
  "image/png,image/jpeg,image/gif,image/bmp,image/webp,image/svg+xml,image/tiff,image/heic";
const VIDEO_MIME_TYPES =
  "video/mp4,video/quicktime,video/x-msvideo,video/x-ms-wmv,video/webm,video/mpeg,video/3gpp,video/x-flv,video/x-matroska,video/ogg";

function openPicker(accessToken: string, kind: "image" | "video", multiple: boolean): Promise<DrivePickedFile[]> {
  return new Promise((resolve, reject) => {
    try {
      const picker = window.google.picker;
      const view = new picker.DocsView(picker.ViewId.DOCS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(false)
        .setMimeTypes(kind === "image" ? IMAGE_MIME_TYPES : VIDEO_MIME_TYPES);
      const builder = new picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(accessToken)
        .setDeveloperKey(API_KEY)
        .setAppId(APP_ID)
        .setOrigin(window.location.origin)
        .setCallback((data: { action: string; docs?: DrivePickedFile[] }) => {
          if (data.action === picker.Action.PICKED) {
            resolve((data.docs ?? []).map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType })));
          } else if (data.action === picker.Action.CANCEL) {
            resolve([]);
          }
        });
      if (multiple) builder.enableFeature(picker.Feature.MULTISELECT_ENABLED);
      builder.build().setVisible(true);
    } catch (err) {
      reject(err instanceof Error ? err : new Error("Failed to open the Google Drive picker."));
    }
  });
}

async function downloadDriveFile(fileId: string, fileName: string, accessToken: string): Promise<Blob> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    // Surface Google's actual reason (e.g. "Drive API has not been used in
    // project ... before or it is disabled", "Insufficient Permission",
    // "File not found") instead of a bare status code — a plain "HTTP 403"
    // is nearly undiagnosable on its own.
    let reason = res.statusText;
    try {
      const body = await res.json();
      reason = body?.error?.message || reason;
    } catch {
      // response wasn't JSON — keep statusText
    }
    throw new Error(`Failed to download "${fileName}" from Google Drive (${res.status}: ${reason}).`);
  }
  return res.blob();
}

/** End-to-end: get a scoped access token (prompting the user if needed),
 * open the Picker filtered to `kind`, download every selected file's bytes,
 * and hand back real File objects — ready to feed into the exact same
 * Cloud Storage upload path (lib/gcs.ts) as a local file input. */
export async function pickFilesFromGoogleDrive(kind: "image" | "video", multiple: boolean): Promise<File[]> {
  if (!isGoogleDriveConfigured()) {
    throw new Error("Google Drive import isn't configured — see frontend/README.md.");
  }
  await loadGoogleScripts();
  const accessToken = await getAccessToken();
  const picked = await openPicker(accessToken, kind, multiple);
  return Promise.all(
    picked.map(async (p) => {
      const blob = await downloadDriveFile(p.id, p.name, accessToken);
      return new File([blob], p.name, { type: p.mimeType || blob.type });
    })
  );
}
