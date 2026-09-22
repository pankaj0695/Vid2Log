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
import { downloadCsv } from "@/lib/csv";
import {
  buildCanonicalCsv,
  buildCombinedCsv,
  parseLogCsv,
  TEMPLATE_COLUMNS,
  TEMPLATE_ROWS,
  type NormalisedScene,
} from "@/lib/logCsv";
import { Tooltip } from "@/components/ui/Tooltip";
import { PAGE_SUBTITLES, BUTTON_TOOLTIPS } from "@/lib/copy";
import { HELP_ANCHORS } from "@/lib/helpContent";

function stagger(index: number, stepMs = 35): CSSProperties {
  return { "--stagger": `${index * stepMs}ms` } as CSSProperties;
}

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

/** Every finished activity log, moved out of Process's old "Activity logs" tab
 * into its own page — this is the "get logs into and out of vid2log" hub,
 * whether that log came from actually processing a video or from importing
 * a hand-built/exported CSV directly. */
function ActivityLogsContent() {
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
  // Errors are a list rather than one string: a spreadsheet usually has the
  // same mistake on many rows, and showing them together lets the whole file
  // be fixed in one pass instead of one failed upload at a time.
  const [csvImportErrors, setCsvImportErrors] = useState<string[]>([]);
  // Whether those errors are about the file's SHAPE (so the format rules are
  // worth restating) or about the upload failing (where they are not, and
  // repeating them would send someone off to edit a file that was fine).
  const [csvErrorsAreFormat, setCsvErrorsAreFormat] = useState(true);
  const [csvImportNotices, setCsvImportNotices] = useState<string[]>([]);
  const [csvImportSummary, setCsvImportSummary] = useState<string | null>(null);
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

  /** Reads the chosen CSV in the browser, repairs what can be repaired (see
   * lib/logCsv.ts), and uploads one canonical CSV per log it found. A file
   * carrying a `user_id` column is a combined export and becomes several
   * logs, one per id, each named after that id. */
  async function handleImportCsv(file: File) {
    setCsvImportErrors([]);
    setCsvImportNotices([]);
    setCsvImportSummary(null);
    setCsvErrorsAreFormat(true);

    const text = await file.text();
    const baseName = file.name.replace(/\.[^.]+$/, "") || "Imported log";
    const parsed = parseLogCsv(text, baseName);

    if (!parsed.ok) {
      setCsvImportErrors(parsed.errors);
      setCsvImportNotices(parsed.notices);
      if (csvInputRef.current) csvInputRef.current.value = "";
      return;
    }

    setCsvImporting(true);
    const imported: string[] = [];
    const failed: string[] = [];
    try {
      for (const log of parsed.logs) {
        const csv = buildCanonicalCsv(log.scenes);
        // The server takes the uploaded file's name as the log's name, so
        // naming the blob after the user_id is what makes a combined file
        // split back into correctly-named logs.
        const blob = new File([csv], `${log.name}.csv`, { type: "text/csv" });
        try {
          await api.logs.importCsv(blob);
          imported.push(log.name);
        } catch (err) {
          failed.push(`${log.name}: ${err instanceof Error ? err.message : "upload failed"}`);
        }
      }
      await loadJobs();

      if (failed.length > 0) {
        setCsvErrorsAreFormat(false);
        setCsvImportErrors(failed);
      }
      if (imported.length > 0) {
        setCsvImportSummary(
          parsed.logs.length > 1
            ? `Imported ${imported.length} log${imported.length > 1 ? "s" : ""}: ${imported.join(", ")}.`
            : `Imported ${imported[0]}.`,
        );
        setCsvImportNotices(parsed.notices);
      }
    } catch (err) {
      setCsvErrorsAreFormat(false);
      setCsvImportErrors([err instanceof Error ? err.message : "Failed to import this CSV."]);
    } finally {
      setCsvImporting(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  }

  function downloadCsvTemplate() {
    downloadCsv("vid2log_log_template.csv", [...TEMPLATE_COLUMNS], TEMPLATE_ROWS);
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

  /** Builds the combined CSV in the browser rather than calling the server's
   * /logs/combine, which labels each block with `video_id` holding an opaque
   * job UUID. Here the column is `user_id` carrying the log's display name,
   * which is what lets the file be re-imported and split back into logs with
   * the names they started with. */
  async function handleCombine() {
    setCombineBusy(true);
    try {
      const selected = doneJobs.filter((j) => combineSelection.has(j.job_id));
      const withScenes = await Promise.all(
        selected.map(async (job) => ({
          name: displayName(job),
          scenes: (await api.logs.get(job.job_id)).scenes.map(
            (s): NormalisedScene => ({
              start_time: s.start_time,
              end_time: s.end_time,
              duration: s.duration,
              action: s.action,
              confidence: s.confidence,
              source: s.source || "csv_import",
            }),
          ),
        })),
      );
      const csv = buildCombinedCsv(withScenes);
      const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
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
    <AppShell section="activity-logs" crumb="Activity logs">
      <Container className="py-10">
        <PageHeader
          eyebrow="Activity logs"
          subtitle={PAGE_SUBTITLES["activity-logs"]}
          title="Activity logs"
          helpAnchor={HELP_ANCHORS.activityLogs}
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
            <Tooltip label={BUTTON_TOOLTIPS.importCsv}>
              <Button size="sm" variant="outline" onClick={() => csvInputRef.current?.click()} loading={csvImporting}>
                Import CSV log
              </Button>
            </Tooltip>
          </div>
        </div>

        {csvImportErrors.length > 0 && (
          <Alert
            tone="danger"
            className="mb-4"
            dismissLabel="Dismiss import errors"
            onDismiss={() => setCsvImportErrors([])}
          >
            <p className="font-medium">
              {csvErrorsAreFormat
                ? "This CSV could not be imported. Fix the following and try again:"
                : "The file was read correctly, but these logs could not be saved:"}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {csvImportErrors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            {csvErrorsAreFormat && (
              <p className="mt-2 text-sm">
                The file needs an <span className="font-mono">action</span> column and any two of{" "}
                <span className="font-mono">start_time</span>, <span className="font-mono">end_time</span> and{" "}
                <span className="font-mono">duration</span>. Column order and capitalisation do not matter.
              </p>
            )}
          </Alert>
        )}

        {csvImportSummary && (
          <Alert
            tone="success"
            className="mb-4"
            dismissLabel="Dismiss import summary"
            onDismiss={() => {
              setCsvImportSummary(null);
              setCsvImportNotices([]);
            }}
          >
            <p className="font-medium">{csvImportSummary}</p>
            {csvImportNotices.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                {csvImportNotices.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
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
                      <Tooltip label={BUTTON_TOOLTIPS.exportCsv}>
                        <Button size="sm" variant="outline" onClick={() => handleDownloadCsv(job)}>
                          Download CSV
                        </Button>
                      </Tooltip>
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
                              <th className="px-3 py-2 font-medium">Action</th>
                              <th className="px-3 py-2 font-medium">Confidence</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-neutral-100 font-mono">
                            {logData.scenes.map((scene, i) => (
                              <tr key={i}>
                                <td className="px-3 py-2">{scene.start_time}</td>
                                <td className="px-3 py-2">{scene.end_time}</td>
                                <td className="px-3 py-2">{scene.duration}</td>
                                <td className="px-3 py-2 font-sans font-medium text-text">{scene.action}</td>
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
        title="Delete this activity log?"
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

export default function ActivityLogsPage() {
  return (
    <ProtectedRoute>
      <ActivityLogsContent />
    </ProtectedRoute>
  );
}
