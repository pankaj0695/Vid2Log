"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { api } from "@/lib/api";
import type { JobOut, LogOut } from "@/lib/types";
import { Container, PageHeader } from "@/components/ui/Section";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton, SkeletonTable } from "@/components/ui/Skeleton";
import { logDisplayName } from "@/lib/format";
import { downloadCsv, findMissingCsvColumns } from "@/lib/csv";

function stagger(index: number, stepMs = 35): CSSProperties {
  return { "--stagger": `${index * stepMs}ms` } as CSSProperties;
}

// Mirrors backend/app/routers/logs.py::REQUIRED_IMPORT_COLUMNS — kept in
// sync so a bad CSV gets rejected immediately client-side instead of only
// after a round trip to the server.
const REQUIRED_CSV_COLUMNS = ["start_time", "end_time", "duration", "class", "confidence"];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function displayName(job: JobOut): string {
  return logDisplayName(job.display_name || job.original_filename);
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

/** Every finished video log, moved out of Process's old "Video logs" tab
 * into its own page — this is the "get logs into and out of vid2log" hub,
 * whether that log came from actually processing a video or from importing
 * a hand-built/exported CSV directly. */
function VideoLogsContent() {
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

  const [csvImporting, setCsvImporting] = useState(false);
  const [csvImportError, setCsvImportError] = useState<string | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  async function loadJobs() {
    try {
      const list = await api.jobs.list(50);
      setJobs(list.filter((j) => j.status === "done"));
      setJobsError(null);
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Failed to load logs.");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadJobs();
  }, []);

  async function handleImportCsv(file: File) {
    setCsvImportError(null);

    const headerText = await file.text();
    const missingColumns = findMissingCsvColumns(headerText, REQUIRED_CSV_COLUMNS);
    if (missingColumns.length > 0) {
      setCsvImportError(
        `This CSV is missing required column${missingColumns.length > 1 ? "s" : ""}: ${missingColumns.join(", ")}. Download the template for the exact format.`
      );
      if (csvInputRef.current) csvInputRef.current.value = "";
      return;
    }

    setCsvImporting(true);
    try {
      await api.logs.importCsv(file);
      await loadJobs();
    } catch (err) {
      setCsvImportError(err instanceof Error ? err.message : "Failed to import this CSV.");
    } finally {
      setCsvImporting(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }

  function downloadCsvTemplate() {
    downloadCsv(
      "vid2log_log_template.csv",
      ["start_time", "end_time", "duration", "class", "confidence", "source"],
      [
        ["00:00:00", "00:00:05", "00:00:05", "Login Screen", "0.95", "manual"],
        ["00:00:05", "00:00:12", "00:00:07", "Dashboard", "0.91", "manual"],
      ]
    );
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

  const doneJobs = jobs ?? [];

  return (
    <AppShell section="video-logs" crumb="Video logs">
      <Container className="py-10">
        <PageHeader
          eyebrow="Video logs"
          title="Video logs"
          description="Every finished log — from a processed video or an imported CSV. Download, combine, rename, or delete them here."
        />

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-neutral-500">
            Already have a log? Import it as a CSV instead of processing a video.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {combineSelection.size >= 2 && (
              <Button size="sm" variant="outline" onClick={handleCombine} loading={combineBusy}>
                Combine {combineSelection.size} logs (CSV)
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={downloadCsvTemplate}>
              Download CSV template
            </Button>
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleImportCsv(file);
              }}
            />
            <Button size="sm" variant="outline" onClick={() => csvInputRef.current?.click()} loading={csvImporting}>
              Import CSV log
            </Button>
          </div>
        </div>

        {csvImportError && (
          <Alert tone="danger" className="mb-4">
            {csvImportError}
          </Alert>
        )}

        {jobsError && (
          <Alert tone="danger" className="mb-4">
            {jobsError}
          </Alert>
        )}

        {jobs === null ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="animate-fade-in-up p-4" style={stagger(i, 60)}>
                <div className="flex items-center gap-3">
                  <Skeleton className="h-4 w-4 shrink-0 rounded" />
                  <div className="min-w-0 flex-1">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="mt-2 h-3 w-1/4" />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : doneJobs.length === 0 ? (
          <EmptyState
            title="No logs yet"
            description="Process a video, or import a CSV log, to see it here."
          />
        ) : (
          <div className="space-y-3">
            {doneJobs.map((job, i) => (
              <Card key={job.job_id} className="animate-fade-in-up p-4" style={stagger(i)}>
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
                      <div className="rounded-lg border border-neutral-200">
                        <SkeletonTable rows={6} cols={5} />
                      </div>
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

export default function VideoLogsPage() {
  return (
    <ProtectedRoute>
      <VideoLogsContent />
    </ProtectedRoute>
  );
}
