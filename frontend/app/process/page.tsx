"use client";

import { useEffect, useRef, useState } from "react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { GoogleDriveImportButton } from "@/components/GoogleDriveImportButton";
import { api } from "@/lib/api";
import { uploadToGCS } from "@/lib/gcs";
import type { JobOut, LogOut, ModelOut } from "@/lib/types";
import { Container, PageHeader } from "@/components/ui/Section";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { StatusBadge } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

type Tab = "new" | "logs" | "history";

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

function displayName(job: JobOut): string {
  return job.display_name || job.original_filename;
}

async function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
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

  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [logData, setLogData] = useState<LogOut | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  const [combineSelection, setCombineSelection] = useState<Set<string>>(new Set());
  const [combineBusy, setCombineBusy] = useState(false);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<JobOut | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

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

  async function toggleLogs(jobId: string) {
    if (expandedJobId === jobId) {
      setExpandedJobId(null);
      setLogData(null);
      return;
    }
    setExpandedJobId(jobId);
    setLogData(null);
    setLogsLoading(true);
    try {
      const data = await api.logs.get(jobId);
      setLogData(data);
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Failed to load logs.");
    } finally {
      setLogsLoading(false);
    }
  }

  async function handleDownloadCsv(job: JobOut) {
    const url = await api.logs.csvUrl(job.job_id);
    await triggerDownload(url, `${job.original_filename.replace(/\.[^.]+$/, "")}_analysis.csv`);
  }

  function toggleCombine(jobId: string) {
    setCombineSelection((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  async function handleCombine() {
    setCombineBusy(true);
    try {
      const url = await api.logs.combine(Array.from(combineSelection));
      await triggerDownload(url, "combined_logs.csv");
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Failed to combine logs.");
    } finally {
      setCombineBusy(false);
    }
  }

  function startRename(job: JobOut) {
    setRenamingId(job.job_id);
    setRenameValue(displayName(job));
    setRenameError(null);
  }

  function cancelRename() {
    setRenamingId(null);
    setRenameError(null);
  }

  async function commitRename(jobId: string) {
    const name = renameValue.trim();
    if (!name) {
      setRenameError("Name can't be empty.");
      return;
    }
    setRenameBusy(true);
    try {
      await api.jobs.rename(jobId, name);
      setRenamingId(null);
      await loadJobs();
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Failed to rename.");
    } finally {
      setRenameBusy(false);
    }
  }

  async function confirmDeleteJob() {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await api.jobs.remove(deleteTarget.job_id);
      setCombineSelection((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.job_id);
        return next;
      });
      if (expandedJobId === deleteTarget.job_id) {
        setExpandedJobId(null);
        setLogData(null);
      }
      setDeleteTarget(null);
      await loadJobs();
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Failed to delete log.");
    } finally {
      setDeleteBusy(false);
    }
  }

  const doneJobs = jobs?.filter((j) => j.status === "done") ?? [];
  const activeCount = jobs?.filter((j) => ACTIVE_STATUSES.has(j.status)).length ?? 0;

  return (
    <AppShell section="process" crumb="Process video">
      <Container className="py-10">
        <PageHeader
          eyebrow="Process"
          title="Process a video"
          description="Upload a screen recording and pick which trained model should classify it. Videos are deleted from storage automatically once processing finishes."
        />

        <Tabs
          tabs={[
            { id: "new", label: "New job" },
            { id: "logs", label: `Video logs${doneJobs.length > 0 ? ` (${doneJobs.length})` : ""}` },
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

        {tab === "logs" && (
          <div>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text">Video logs</h2>
              {combineSelection.size >= 2 && (
                <Button size="sm" variant="outline" onClick={handleCombine} loading={combineBusy}>
                  Combine {combineSelection.size} logs (CSV)
                </Button>
              )}
            </div>

            {jobsError && (
              <Alert tone="danger" className="mb-4">
                {jobsError}
              </Alert>
            )}

            {jobs === null ? (
              <Spinner label="Loading logs..." />
            ) : doneJobs.length === 0 ? (
              <EmptyState
                title="No logs yet"
                description="Process a video in the New job tab — its log will show up here once it's done."
              />
            ) : (
              <div className="space-y-3">
                {doneJobs.map((job) => (
                  <Card key={job.job_id} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <input
                          type="checkbox"
                          checked={combineSelection.has(job.job_id)}
                          onChange={() => toggleCombine(job.job_id)}
                          aria-label={`Select ${displayName(job)} for combining`}
                          className="h-4 w-4 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          {renamingId === job.job_id ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <Input
                                autoFocus
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitRename(job.job_id);
                                  if (e.key === "Escape") cancelRename();
                                }}
                                className="max-w-xs"
                              />
                              <Button size="sm" onClick={() => commitRename(job.job_id)} loading={renameBusy}>
                                Save
                              </Button>
                              <Button size="sm" variant="ghost" onClick={cancelRename} disabled={renameBusy}>
                                Cancel
                              </Button>
                            </div>
                          ) : (
                            <>
                              <p className="truncate text-sm font-medium text-text">{displayName(job)}</p>
                              <p className="text-sm text-neutral-500">
                                {formatDate(job.created_at)}
                                {job.scene_count != null ? ` · ${job.scene_count} scenes` : ""}
                              </p>
                            </>
                          )}
                          {renamingId === job.job_id && renameError && (
                            <p className="mt-1 text-sm text-danger">{renameError}</p>
                          )}
                        </div>
                      </div>
                      {renamingId !== job.job_id && (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button size="sm" variant="ghost" onClick={() => toggleLogs(job.job_id)}>
                            {expandedJobId === job.job_id ? "Hide log" : "View log"}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => handleDownloadCsv(job)}>
                            Download CSV
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => startRename(job)}>
                            Rename
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => setDeleteTarget(job)}>
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
                    {expandedJobId === job.job_id && (
                      <div className="mt-4 border-t border-neutral-100 pt-4">
                        {logsLoading ? (
                          <Spinner label="Loading scenes..." />
                        ) : logData ? (
                          <div className="max-h-80 overflow-auto rounded-lg border border-neutral-200">
                            <table className="w-full text-left text-sm">
                              <thead className="bg-neutral-50 text-neutral-500">
                                <tr>
                                  <th className="px-3 py-2 font-medium">Start</th>
                                  <th className="px-3 py-2 font-medium">End</th>
                                  <th className="px-3 py-2 font-medium">Duration</th>
                                  <th className="px-3 py-2 font-medium">Class</th>
                                  <th className="px-3 py-2 font-medium">Confidence</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-neutral-100 font-mono">
                                {logData.scenes.map((scene, i) => (
                                  <tr key={i}>
                                    <td className="px-3 py-2">{scene.start_time}</td>
                                    <td className="px-3 py-2">{scene.end_time}</td>
                                    <td className="px-3 py-2">{scene.duration}</td>
                                    <td className="px-3 py-2 font-sans font-medium text-text">{scene.class}</td>
                                    <td className="px-3 py-2">{(scene.confidence * 100).toFixed(1)}%</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}

            {doneJobs.length > 0 && combineSelection.size === 0 && (
              <p className="mt-3 text-sm text-neutral-500">
                Tip: select two or more logs above to combine them into one CSV.
              </p>
            )}
          </div>
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
              <Spinner label="Loading jobs..." />
            ) : jobs.length === 0 ? (
              <EmptyState title="No jobs yet" description="Upload a video in the New job tab to get started." />
            ) : (
              <div className="space-y-3">
                {jobs.map((job) => (
                  <Card key={job.job_id} className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text">{displayName(job)}</p>
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

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this video log?"
        description={
          deleteTarget && (
            <>
              This permanently deletes the log for <span className="font-medium text-text">{displayName(deleteTarget)}</span>.
              This can&apos;t be undone.
            </>
          )
        }
        confirmLabel="Delete log"
        busy={deleteBusy}
        onConfirm={confirmDeleteJob}
        onCancel={() => setDeleteTarget(null)}
      />
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
