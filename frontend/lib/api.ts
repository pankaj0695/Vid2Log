"use client";

// Thin typed wrapper around the FastAPI backend. Every authenticated call
// grabs a fresh ID token straight off the current Firebase user — callers
// never have to thread a token through manually.
import { auth } from "./firebase";
// Fires GA4 events for the product's key funnel actions right where they
// actually succeed (after `request()` resolves without throwing) — one
// place to instrument instead of scattering `trackEvent()` calls across
// every page component that happens to call these. Named import, not
// `api.analytics`, to avoid colliding with the unrelated SPM/DSM namespace
// further down this file.
import { trackEvent } from "./firebase-analytics";
import type {
  ActionDiscoveryJobOut,
  ActionDatasetOut,
  AdminStats,
  DSMPattern,
  DSMTestType,
  JobOut,
  LogOut,
  ModelOut,
  SaveActionClass,
  UpdateActionClass,
  SPMPattern,
  SPMSortBy,
  SplitRatios,
  TrainingImageRef,
  TrainJobOut,
  UserProfile,
} from "./types";

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const user = auth.currentUser;
  if (!user) return {};
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormBody = options.body instanceof FormData;
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body && !isFormBody ? { "Content-Type": "application/json" } : {}),
      ...(await authHeader()),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let detail: unknown;
    try {
      const body = await res.json();
      detail = body?.detail ?? body;
    } catch {
      detail = res.statusText;
    }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return (await res.json()) as T;
  return (await res.blob()) as unknown as T;
}

export const api = {
  health: () => request<{ status: string; firebase_configured: boolean }>("/health"),

  users: {
    bootstrap: (display_name?: string) =>
      request<UserProfile>("/users/bootstrap", {
        method: "POST",
        body: JSON.stringify({ display_name: display_name ?? null }),
      }),
    me: () => request<UserProfile>("/users/me"),
  },

  uploads: {
    signedUrl: (payload: { filename: string; content_type: string; kind: string }) =>
      request<{ upload_url: string; storage_path: string }>("/uploads/signed-url", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
  },

  jobs: {
    create: (payload: {
      storage_path: string;
      resource_type?: string;
      original_filename: string;
      fps?: number;
      model_id?: string | null;
    }) =>
      request<JobOut>("/jobs", { method: "POST", body: JSON.stringify(payload) }).then((job) => {
        trackEvent("video_processing_started", {
          fps: payload.fps ?? null,
          has_model: Boolean(payload.model_id),
        });
        return job;
      }),
    list: (limit = 50) => request<JobOut[]>(`/jobs?limit=${limit}`),
    get: (jobId: string) => request<JobOut>(`/jobs/${jobId}`),
    cancel: (jobId: string) => request<{ status: string; note?: string }>(`/jobs/${jobId}`, { method: "DELETE" }),
    rename: (jobId: string, displayName: string) =>
      request<JobOut>(`/jobs/${jobId}`, { method: "PATCH", body: JSON.stringify({ display_name: displayName }) }),
    // Same endpoint as cancel() — the backend cancels a still-queued job or
    // actually deletes a finished one depending on its status. Named
    // separately here so call sites read clearly (Job history's "Cancel"
    // button vs Video logs' "Delete" button).
    remove: (jobId: string) => request<{ status: string; note?: string }>(`/jobs/${jobId}`, { method: "DELETE" }),
  },

  logs: {
    get: (jobId: string) => request<LogOut>(`/logs/${jobId}`),
    csvUrl: async (jobId: string) => {
      const blob = await request<Blob>(`/logs/${jobId}/csv`);
      trackEvent("log_exported", { format: "csv", job_id: jobId });
      return URL.createObjectURL(blob);
    },
    combine: async (jobIds: string[]) => {
      const blob = await request<Blob>("/logs/combine", {
        method: "POST",
        body: JSON.stringify(jobIds),
      });
      trackEvent("log_exported", { format: "csv", combined: true, num_jobs: jobIds.length });
      return URL.createObjectURL(blob);
    },
    // FormData body — `request()` already skips setting a Content-Type
    // header for FormData so the browser can fill in the multipart
    // boundary itself; no video pipeline involved, so this returns
    // straight away with a "done" job, not a "queued" one to poll.
    importCsv: (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      return request<JobOut>("/logs/import", { method: "POST", body: formData }).then((job) => {
        trackEvent("log_imported", { format: "csv" });
        return job;
      });
    },
  },

  models: {
    list: () => request<ModelOut[]>("/models"),
    get: (modelId: string) => request<ModelOut>(`/models/${modelId}`),
    register: (payload: {
      name: string;
      model_storage_path: string;
      text_model_storage_path?: string;
      labels: string[];
      metrics?: unknown;
      dataset_version?: string;
    }) => request<ModelOut>("/models", { method: "POST", body: JSON.stringify(payload) }),
    activate: (modelId: string) =>
      request<ModelOut>(`/models/${modelId}/activate`, { method: "PATCH" }).then((model) => {
        trackEvent("model_activated", { model_id: modelId });
        return model;
      }),
    updateKeywordRules: (modelId: string, keywordRules: Record<string, string[]>) =>
      request<ModelOut>(`/models/${modelId}/keyword-rules`, {
        method: "PATCH",
        body: JSON.stringify({ keyword_rules: keywordRules }),
      }),
    rename: (modelId: string, name: string) =>
      request<ModelOut>(`/models/${modelId}/rename`, { method: "PATCH", body: JSON.stringify({ name }) }),
    remove: (modelId: string) => request<{ status: string }>(`/models/${modelId}`, { method: "DELETE" }),
  },

  train: {
    start: (payload: {
      model_name: string;
      dataset: Record<string, TrainingImageRef[]>;
      split?: SplitRatios;
      epochs?: number;
      batch_size?: number;
      learning_rate?: number;
      keyword_rules?: Record<string, string[]> | null;
    }) =>
      request<TrainJobOut>("/train", { method: "POST", body: JSON.stringify(payload) }).then((job) => {
        trackEvent("training_started", {
          epochs: payload.epochs ?? null,
          batch_size: payload.batch_size ?? null,
          num_actions: Object.keys(payload.dataset).length,
        });
        return job;
      }),
    list: (limit = 50) => request<TrainJobOut[]>(`/train?limit=${limit}`),
    status: (trainingJobId: string) => request<TrainJobOut>(`/train/${trainingJobId}`),
    retry: (trainingJobId: string) =>
      request<TrainJobOut>(`/train/${trainingJobId}/retry`, { method: "POST" }).then((job) => {
        trackEvent("training_retried", { training_job_id: trainingJobId });
        return job;
      }),
  },

  actions: {
    discover: (payload: {
      storage_path: string;
      original_filename: string;
      fps?: number;
      min_cluster_size?: number;
    }) =>
      request<ActionDiscoveryJobOut>("/actions/discover", { method: "POST", body: JSON.stringify(payload) }).then(
        (job) => {
          trackEvent("action_discovery_started", {
            fps: payload.fps ?? null,
            min_cluster_size: payload.min_cluster_size ?? null,
          });
          return job;
        }
      ),
    listDiscoveryJobs: (limit = 20) => request<ActionDiscoveryJobOut[]>(`/actions/discover?limit=${limit}`),
    getDiscoveryJob: (jobId: string) => request<ActionDiscoveryJobOut>(`/actions/discover/${jobId}`),
    // Preview frames are proxied bytes behind auth, not a public URL — fetch
    // via the authed request() helper and hand back a blob object URL the
    // caller can drop straight into an <img src>, same pattern as
    // logs.csvUrl() above. Caller is responsible for revoking it when done.
    frameUrl: async (jobId: string, clusterId: string, frameId: string) => {
      const blob = await request<Blob>(`/actions/discover/${jobId}/frames/${clusterId}/${frameId}`);
      return URL.createObjectURL(blob);
    },
    cancelOrDeleteDiscoveryJob: (jobId: string) =>
      request<{ status: string; note?: string }>(`/actions/discover/${jobId}`, { method: "DELETE" }),
    saveDataset: (jobId: string, payload: { name: string; classes: SaveActionClass[] }) =>
      request<ActionDatasetOut>(`/actions/discover/${jobId}/save`, {
        method: "POST",
        body: JSON.stringify(payload),
      }).then((dataset) => {
        trackEvent("action_dataset_saved", { dataset_name: payload.name, num_actions: payload.classes.length });
        return dataset;
      }),

    listDatasets: (limit = 100) => request<ActionDatasetOut[]>(`/actions/datasets?limit=${limit}`),
    getDataset: (datasetId: string) => request<ActionDatasetOut>(`/actions/datasets/${datasetId}`),
    // Re-saves an existing dataset after editing (rename/merge/add/delete
    // actions or images) — same all-at-once shape as saveDataset above, but
    // sourced from the dataset's own stored images instead of a discovery
    // job's temp previews.
    updateDataset: (datasetId: string, payload: { name: string; classes: UpdateActionClass[] }) =>
      request<ActionDatasetOut>(`/actions/datasets/${datasetId}`, { method: "PUT", body: JSON.stringify(payload) }),
    datasetImageUrl: async (datasetId: string, classIndex: number, imageIndex: number) => {
      const blob = await request<Blob>(`/actions/datasets/${datasetId}/classes/${classIndex}/images/${imageIndex}`);
      return URL.createObjectURL(blob);
    },
    deleteDataset: (datasetId: string) => request<{ status: string }>(`/actions/datasets/${datasetId}`, { method: "DELETE" }),
    // Used by Train's "Import from saved dataset" option — makes fresh,
    // disposable training-uploads/ copies of the requested classes'
    // images. classNames omitted/undefined -> copy every class.
    copyForTraining: (datasetId: string, classNames?: string[] | null) =>
      request<Record<string, TrainingImageRef[]>>(`/actions/datasets/${datasetId}/copy-for-training`, {
        method: "POST",
        body: JSON.stringify({ class_names: classNames ?? null }),
      }),
  },

  analytics: {
    spm: (payload: {
      job_ids: string[];
      min_support?: number;
      top_k?: number;
      sliding_window_min?: number;
      sliding_window_max?: number;
      min_gap?: number;
      max_gap?: number | null;
      min_instance_support?: number;
      sort_by?: SPMSortBy;
    }) => request<SPMPattern[]>("/analytics/spm", { method: "POST", body: JSON.stringify(payload) }),
    dsm: (payload: {
      group_a_job_ids: string[];
      group_b_job_ids: string[];
      min_support?: number;
      top_k?: number;
      sliding_window_min?: number;
      sliding_window_max?: number;
      min_gap?: number;
      max_gap?: number | null;
      min_instance_support?: number;
      test_type?: DSMTestType;
      threshold_p_value?: number;
    }) => request<DSMPattern[]>("/analytics/dsm", { method: "POST", body: JSON.stringify(payload) }),
  },

  admin: {
    cleanupStaleVideos: (olderThanHours = 24) =>
      request<{ found: number; deleted: number; blob_paths: string[] }>(
        `/admin/cleanup-stale-videos?older_than_hours=${olderThanHours}`,
        { method: "POST" }
      ),
    listUsers: () => request<UserProfile[]>("/admin/users"),
    updateUserRole: (uid: string, role: "user" | "admin") =>
      request<UserProfile>(`/admin/users/${uid}/role`, { method: "PATCH", body: JSON.stringify({ role }) }),
    stats: () => request<AdminStats>("/admin/stats"),
  },
};
