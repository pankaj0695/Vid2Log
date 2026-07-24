"use client";

// Thin typed wrapper around the FastAPI backend. Every authenticated call
// grabs a fresh ID token straight off the current Firebase user — callers
// never have to thread a token through manually.
import { auth } from "./firebase";
import type {
  AdminStats,
  DSMPattern,
  DSMTestType,
  JobOut,
  LogOut,
  ModelOut,
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
    }) => request<JobOut>("/jobs", { method: "POST", body: JSON.stringify(payload) }),
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
      return URL.createObjectURL(blob);
    },
    combine: async (jobIds: string[]) => {
      const blob = await request<Blob>("/logs/combine", {
        method: "POST",
        body: JSON.stringify(jobIds),
      });
      return URL.createObjectURL(blob);
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
    activate: (modelId: string) => request<ModelOut>(`/models/${modelId}/activate`, { method: "PATCH" }),
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
    }) => request<TrainJobOut>("/train", { method: "POST", body: JSON.stringify(payload) }),
    list: (limit = 50) => request<TrainJobOut[]>(`/train?limit=${limit}`),
    status: (trainingJobId: string) => request<TrainJobOut>(`/train/${trainingJobId}`),
    retry: (trainingJobId: string) => request<TrainJobOut>(`/train/${trainingJobId}/retry`, { method: "POST" }),
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
