"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { GoogleDriveImportButton } from "@/components/GoogleDriveImportButton";
import { api } from "@/lib/api";
import { uploadToGCS } from "@/lib/gcs";
import type { JobOut, ModelOut } from "@/lib/types";
import { Container, PageHeader } from "@/components/ui/Section";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { StatusBadge } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { Skeleton } from "@/components/ui/Skeleton";

function stagger(index: number, stepMs = 45): CSSProperties {
  return { "--stagger": `${index * stepMs}ms` } as CSSProperties;
}

type Tab = "new" | "history";

const ACTIVE_STATUSES = new Set(["queued", "processing"]);

/** Tracks one video through its own upload → job-creation lifecycle,
 * independent of every other selected video — each one gets uploaded (via
 * its own signed URL) and queued as soon as ITS upload finishes, not
 * gated on the others, so multiple videos genuinely process in parallel
 * once there's more than one worker running. */
interface PendingUpload {
  file: File;
  progress: number; // 0-1, upload progress only (job creation itself is near-instant)
  status: "uploading" | "queued" | "error";
  error?: string;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

// Job history lists the underlying processing job itself (queued/processing/
// done/failed) — it should read as "the video I uploaded", so it keeps
// whatever extension the source file actually has (.mp4, .mov, etc.),
// unlike the Video logs tab which shows the resulting CSV log.
function rawJobName(job: JobOut): string {
  return job.display_name || job.original_filename;
}

function ProcessContent() {
  const [tab, setTab] = useState<Tab>("new");
  const [models, setModels] = useState<ModelOut[] | null>(null);

  const [videoFiles, setVideoFiles] = useState<File[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [fps, setFps] = useState(2);
  const [uploading, setUploading] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [jobs, setJobs] = useState<JobOut[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);

  async function loadJobs() {
    try {
      const list = await api.jobs.list(50);
      setJobs(list);
      setJobsError(null);
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Failed to load jobs.");
    }
  }

  useEffect(() => {
    api.models.list().then(setModels).catch(() => setModels([]));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadJobs();
  }, []);

  useEffect(() => {
    const hasActive = jobs?.some((j) => ACTIVE_STATUSES.has(j.status));
    if (!hasActive) return;
    const interval = setInterval(loadJobs, 4000);
    return () => clearInterval(interval);
  }, [jobs]);

  function addVideoFiles(files: File[]) {
    if (files.length === 0) return;
    setVideoFiles((prev) => [...prev, ...files]);
  }

  function removeVideoFile(index: number) {
    setVideoFiles((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleUpload() {
    setUploadError(null);
    if (videoFiles.length === 0) {
      setUploadError("Choose one or more video files first.");
      return;
    }
    const batch = videoFiles;
    setUploading(true);
    setPendingUploads(batch.map((file) => ({ file, progress: 0, status: "uploading" })));
    setVideoFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";

    // Each video uploads and gets queued independently — one video's upload
    // failing (or just taking longer) doesn't block the others from
    // finishing and getting queued for processing right away.
    await Promise.allSettled(
      batch.map(async (file, i) => {
        try {
          const result = await uploadToGCS(file, "video-uploads", (fraction) => {
            setPendingUploads((prev) => prev.map((p, idx) => (idx === i ? { ...p, progress: fraction } : p)));
          });
          await api.jobs.create({
            storage_path: result.storage_path,
            resource_type: "video",
            original_filename: file.name,
            fps,
            model_id: selectedModelId || null,
          });
          setPendingUploads((prev) => prev.map((p, idx) => (idx === i ? { ...p, status: "queued", progress: 1 } : p)));
          await loadJobs();
        } catch (err) {
          setPendingUploads((prev) =>
            prev.map((p, idx) =>
              idx === i
                ? { ...p, status: "error", error: err instanceof Error ? err.message : "Failed to upload/queue the video." }
                : p
            )
          );
        }
      })
    );

    setUploading(false);
  }

  async function handleCancel(jobId: string) {
    await api.jobs.cancel(jobId);
    await loadJobs();
  }

  const activeCount = jobs?.filter((j) => ACTIVE_STATUSES.has(j.status)).length ?? 0;

  return (
    <AppShell section="process" crumb="Process video">
      <Container className="py-10">
        <PageHeader
          eyebrow="Process"
          title="Process a video"
          description="Upload a screen recording and pick which trained model should classify it. Videos are deleted from storage automatically once processing finishes."
          action={
            <Link href="/video-logs" className={buttonClasses({ variant: "outline" })}>
              Video logs
            </Link>
          }
        />

        <Tabs
          tabs={[
            { id: "new", label: "New job" },
            { id: "history", label: `Job history${activeCount > 0 ? ` (${activeCount} active)` : ""}` },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === "new" && (
          <Card className="max-w-3xl">
            <CardHeader title="New job" />
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="sm:col-span-3">
                <Label htmlFor="video-file">Screen recordings</Label>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    id="video-file"
                    ref={fileInputRef}
                    type="file"
                    accept="video/*"
                    multiple
                    disabled={uploading}
                    onChange={(e) => {
                      addVideoFiles(Array.from(e.target.files ?? []));
                      e.target.value = "";
                    }}
                    className="block flex-1 text-sm text-neutral-600 file:mr-4 file:h-11 file:rounded-lg file:border-0 file:bg-primary-tint file:px-4 file:text-sm file:font-medium file:text-primary-hover hover:file:bg-primary/20"
                  />
                  <GoogleDriveImportButton kind="video" multiple disabled={uploading} onFilesSelected={addVideoFiles} />
                </div>
                {videoFiles.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {videoFiles.map((file, i) => (
                      <li
                        key={`${file.name}-${i}`}
                        className="flex items-center justify-between gap-2 rounded-lg bg-neutral-50 px-3 py-1.5 text-sm text-neutral-600"
                      >
                        <span className="truncate">{file.name}</span>
                        <button
                          type="button"
                          onClick={() => removeVideoFile(i)}
                          className="shrink-0 text-neutral-400 hover:text-danger"
                          aria-label={`Remove ${file.name}`}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-1.5 text-sm text-neutral-500">
                  Select multiple files (or Ctrl/Cmd-click) to queue several videos at once — each one uploads and
                  starts processing independently, in parallel with however many workers you have running.
                </p>
              </div>
              <div>
                <Label htmlFor="model-select">Model</Label>
                <Select
                  id="model-select"
                  value={selectedModelId}
                  onChange={(e) => setSelectedModelId(e.target.value)}
                  disabled={uploading}
                >
                  <option value="">Use active model</option>
                  {models?.map((m) => (
                    <option key={m.model_id} value={m.model_id}>
                      {m.name}
                      {m.is_active ? " (active)" : ""}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="fps">Sampling FPS</Label>
                <Input
                  id="fps"
                  type="number"
                  min={1}
                  max={30}
                  value={fps}
                  onChange={(e) => setFps(Number(e.target.value) || 1)}
                  disabled={uploading}
                />
              </div>
              <div className="flex items-end">
                <Button className="w-full" onClick={handleUpload} loading={uploading} disabled={videoFiles.length === 0}>
                  Upload &amp; process {videoFiles.length > 0 ? `(${videoFiles.length})` : ""}
                </Button>
              </div>
            </div>

            {pendingUploads.length > 0 && (
              <div className="mt-4 space-y-3">
                {pendingUploads.map((p, i) => (
                  <div key={`${p.file.name}-${i}`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="truncate text-neutral-600">{p.file.name}</span>
                      <span
                        className={
                          p.status === "error" ? "text-danger" : p.status === "queued" ? "text-success" : "text-neutral-500"
                        }
                      >
                        {p.status === "error" ? "Failed" : p.status === "queued" ? "Queued" : `${Math.round(p.progress * 100)}%`}
                      </span>
                    </div>
                    {p.status === "uploading" && <ProgressBar fraction={p.progress} />}
                    {p.status === "error" && p.error && <p className="mt-1 text-sm text-danger">{p.error}</p>}
                  </div>
                ))}
              </div>
            )}
            {uploadError && (
              <Alert tone="danger" className="mt-4">
                {uploadError}
              </Alert>
            )}
          </Card>
        )}

        {tab === "history" && (
          <div>
            <h2 className="mb-4 text-lg font-semibold text-text">Job history</h2>

            {jobsError && (
              <Alert tone="danger" className="mb-4">
                {jobsError}
              </Alert>
            )}

            {jobs === null ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Card key={i} className="animate-fade-in-up p-4" style={stagger(i, 60)}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <Skeleton className="h-4 w-1/3" />
                        <Skeleton className="mt-2 h-3 w-1/4" />
                      </div>
                      <Skeleton className="h-6 w-20 shrink-0" />
                    </div>
                  </Card>
                ))}
              </div>
            ) : jobs.length === 0 ? (
              <EmptyState title="No jobs yet" description="Upload a video in the New job tab to get started." />
            ) : (
              <div className="space-y-3">
                {jobs.map((job, i) => (
                  <Card key={job.job_id} className="animate-fade-in-up p-4" style={stagger(i, 35)}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text">{rawJobName(job)}</p>
                        <p className="text-sm text-neutral-500">
                          {formatDate(job.created_at)}
                          {job.scene_count != null ? ` · ${job.scene_count} scenes` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={job.status} />
                        {job.status === "queued" && (
                          <Button size="sm" variant="ghost" onClick={() => handleCancel(job.job_id)}>
                            Cancel
                          </Button>
                        )}
                      </div>
                    </div>
                    {job.status === "failed" && job.error && (
                      <Alert tone="danger" className="mt-3">
                        {job.error}
                      </Alert>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}
      </Container>
    </AppShell>
  );
}

export default function ProcessPage() {
  return (
    <ProtectedRoute>
      <ProcessContent />
    </ProtectedRoute>
  );
}
