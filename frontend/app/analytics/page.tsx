"use client";

import { useEffect, useMemo, useState } from "react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { api } from "@/lib/api";
import type { DSMPattern, JobOut, LogOut, SPMPattern } from "@/lib/types";
import { Container, PageHeader } from "@/components/ui/Section";
import { Card, CardHeader } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { BarChart, DonutChart, DivergingBarChart, HorizontalBarChart, GanttTimeline } from "@/components/ui/charts";

type Tab = "overview" | "spm" | "dsm" | "timeline";

interface ClassAgg {
  count: number;
  totalSec: number;
  confSum: number;
}

interface OverviewResult {
  videoCount: number;
  totalScenes: number;
  totalDurationSec: number;
  avgConfidence: number;
  classAgg: Record<string, ClassAgg>;
  sourceCounts: Record<string, number>;
  perVideo: { label: string; value: number }[];
}

const SOURCE_LABELS: Record<string, string> = {
  cnn: "Image classifier",
  keyword_rule: "Keyword rule",
  fusion: "CNN + OCR fusion",
  cnn_per_class_override: "CNN (OCR excluded)",
};

function parseHms(s: string): number {
  const parts = s.split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function formatSeconds(totalSeconds: number): string {
  const t = Math.round(totalSeconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function AnalyticsContent() {
  const [jobs, setJobs] = useState<JobOut[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  // Overview state — descriptive stats computed on demand across whichever
  // videos the researcher picks, not silently over "recent" ones, so the
  // numbers always match a set of videos they consciously chose.
  const [overviewSelection, setOverviewSelection] = useState<Set<string>>(new Set());
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewResult, setOverviewResult] = useState<OverviewResult | null>(null);

  // SPM state
  const [spmSelection, setSpmSelection] = useState<Set<string>>(new Set());
  const [spmMinSupport, setSpmMinSupport] = useState(0.3);
  const [spmTopK, setSpmTopK] = useState(10);
  const [spmResults, setSpmResults] = useState<SPMPattern[] | null>(null);
  const [spmLoading, setSpmLoading] = useState(false);
  const [spmError, setSpmError] = useState<string | null>(null);

  // DSM state
  const [groupA, setGroupA] = useState<Set<string>>(new Set());
  const [groupB, setGroupB] = useState<Set<string>>(new Set());
  const [dsmMinSupport, setDsmMinSupport] = useState(0.2);
  const [dsmTopK, setDsmTopK] = useState(10);
  const [dsmResults, setDsmResults] = useState<DSMPattern[] | null>(null);
  const [dsmLoading, setDsmLoading] = useState(false);
  const [dsmError, setDsmError] = useState<string | null>(null);

  // Video timeline state
  const [timelineJobId, setTimelineJobId] = useState("");
  const [timelineLog, setTimelineLog] = useState<LogOut | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  useEffect(() => {
    api.jobs
      .list(100)
      .then((list) => setJobs(list.filter((j) => j.status === "done")))
      .catch((err) => setJobsError(err instanceof Error ? err.message : "Failed to load jobs."));
  }, []);

  const doneJobs = useMemo(() => jobs ?? [], [jobs]);

  function toggleOverview(jobId: string) {
    setOverviewSelection((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  async function runOverview() {
    setOverviewError(null);
    if (overviewSelection.size < 1) {
      setOverviewError("Select at least one processed video.");
      return;
    }
    setOverviewLoading(true);
    try {
      const selectedJobs = doneJobs.filter((j) => overviewSelection.has(j.job_id));
      const logs = await Promise.all(selectedJobs.map((j) => api.logs.get(j.job_id)));

      const classAgg: Record<string, ClassAgg> = {};
      const sourceCounts: Record<string, number> = {};
      const perVideo: { label: string; value: number }[] = [];
      let totalScenes = 0;
      let totalDurationSec = 0;
      let confSum = 0;

      logs.forEach((log, i) => {
        perVideo.push({ label: selectedJobs[i].original_filename, value: log.scenes.length });
        for (const scene of log.scenes) {
          const sec = parseHms(scene.duration);
          const agg = classAgg[scene.class] ?? { count: 0, totalSec: 0, confSum: 0 };
          agg.count += 1;
          agg.totalSec += sec;
          agg.confSum += scene.confidence;
          classAgg[scene.class] = agg;

          const src = scene.source ?? "cnn";
          sourceCounts[src] = (sourceCounts[src] ?? 0) + 1;

          totalScenes += 1;
          totalDurationSec += sec;
          confSum += scene.confidence;
        }
      });

      setOverviewResult({
        videoCount: selectedJobs.length,
        totalScenes,
        totalDurationSec,
        avgConfidence: totalScenes ? confSum / totalScenes : 0,
        classAgg,
        sourceCounts,
        perVideo,
      });
    } catch (err) {
      setOverviewError(err instanceof Error ? err.message : "Failed to aggregate scene logs.");
    } finally {
      setOverviewLoading(false);
    }
  }

  const classRows = useMemo(() => {
    if (!overviewResult) return [];
    return Object.entries(overviewResult.classAgg)
      .map(([label, agg]) => ({
        label,
        count: agg.count,
        totalSec: agg.totalSec,
        avgDurationSec: agg.totalSec / agg.count,
        avgConfidence: agg.confSum / agg.count,
      }))
      .sort((a, b) => b.totalSec - a.totalSec);
  }, [overviewResult]);

  function toggleSpm(jobId: string) {
    setSpmSelection((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  }

  function setGroup(jobId: string, group: "a" | "b" | null) {
    setGroupA((prev) => {
      const next = new Set(prev);
      if (group === "a") next.add(jobId);
      else next.delete(jobId);
      return next;
    });
    setGroupB((prev) => {
      const next = new Set(prev);
      if (group === "b") next.add(jobId);
      else next.delete(jobId);
      return next;
    });
  }

  async function runSpm() {
    setSpmError(null);
    if (spmSelection.size < 1) {
      setSpmError("Select at least one processed video.");
      return;
    }
    setSpmLoading(true);
    try {
      const results = await api.analytics.spm({
        job_ids: Array.from(spmSelection),
        min_support: spmMinSupport,
        top_k: spmTopK,
      });
      setSpmResults(results);
    } catch (err) {
      setSpmError(err instanceof Error ? err.message : "Failed to run pattern mining.");
    } finally {
      setSpmLoading(false);
    }
  }

  async function runDsm() {
    setDsmError(null);
    if (groupA.size < 1 || groupB.size < 1) {
      setDsmError("Both Group A and Group B need at least one video.");
      return;
    }
    setDsmLoading(true);
    try {
      const results = await api.analytics.dsm({
        group_a_job_ids: Array.from(groupA),
        group_b_job_ids: Array.from(groupB),
        min_support: dsmMinSupport,
        top_k: dsmTopK,
      });
      setDsmResults(results);
    } catch (err) {
      setDsmError(err instanceof Error ? err.message : "Failed to run differential mining.");
    } finally {
      setDsmLoading(false);
    }
  }

  async function loadTimeline(jobId: string) {
    setTimelineJobId(jobId);
    setTimelineLog(null);
    setTimelineError(null);
    if (!jobId) return;
    setTimelineLoading(true);
    try {
      setTimelineLog(await api.logs.get(jobId));
    } catch (err) {
      setTimelineError(err instanceof Error ? err.message : "Failed to load this video's scene log.");
    } finally {
      setTimelineLoading(false);
    }
  }

  const timelineSegments = useMemo(() => {
    if (!timelineLog) return null;
    return timelineLog.scenes.map((s) => ({
      label: s.class,
      startSec: parseHms(s.start_time),
      endSec: parseHms(s.end_time),
    }));
  }, [timelineLog]);

  return (
    <AppShell section="analytics" crumb="Analytics">
      <Container className="py-10">
        <PageHeader
          eyebrow="Analytics"
          title="Pattern analysis"
          description="See what your processed videos actually contain — class distribution, common workflows, what differs between groups, and one video at a time."
        />

        <Tabs
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "spm", label: "Sequential patterns (SPM)" },
            { id: "dsm", label: "Differential patterns (DSM)" },
            { id: "timeline", label: "Video timeline" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {jobsError && <Alert tone="danger" className="mb-6">{jobsError}</Alert>}

        {jobs === null ? (
          <Spinner label="Loading your processed videos..." />
        ) : doneJobs.length === 0 ? (
          <EmptyState
            title="No completed videos yet"
            description="Process at least one video before running pattern analysis."
          />
        ) : tab === "overview" ? (
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title="Select videos"
                description="Descriptive stats below are computed only across the videos you pick here."
              />
              <ul className="max-h-96 space-y-1 overflow-auto">
                {doneJobs.map((job) => (
                  <li key={job.job_id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-neutral-50">
                      <input
                        type="checkbox"
                        checked={overviewSelection.has(job.job_id)}
                        onChange={() => toggleOverview(job.job_id)}
                        className="h-4 w-4"
                      />
                      <span className="truncate text-sm text-text">{job.original_filename}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Generate report" />
              <p className="mb-4 text-sm text-neutral-500">
                {overviewSelection.size} video{overviewSelection.size === 1 ? "" : "s"} selected
              </p>
              <Button className="w-full" onClick={runOverview} loading={overviewLoading}>
                Generate report
              </Button>
              {overviewError && (
                <Alert tone="danger" className="mt-3">
                  {overviewError}
                </Alert>
              )}
            </Card>

            {overviewResult && (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:col-span-3 lg:grid-cols-4">
                  <StatCard label="Videos analyzed" value={overviewResult.videoCount} />
                  <StatCard label="Total scenes" value={overviewResult.totalScenes} />
                  <StatCard label="Total duration" value={formatSeconds(overviewResult.totalDurationSec)} />
                  <StatCard label="Avg. confidence" value={`${(overviewResult.avgConfidence * 100).toFixed(1)}%`} />
                </div>

                <Card className="lg:col-span-3">
                  <CardHeader
                    title="Per-class summary"
                    description="Sorted by total time spent — the classes that actually dominated these sessions, not just the ones with the most short-lived scenes."
                  />
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-neutral-50 text-neutral-500">
                        <tr>
                          <th className="px-3 py-2 font-medium">Class</th>
                          <th className="px-3 py-2 font-medium">Scenes</th>
                          <th className="px-3 py-2 font-medium">Total time</th>
                          <th className="px-3 py-2 font-medium">Avg. scene length</th>
                          <th className="px-3 py-2 font-medium">Avg. confidence</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-100">
                        {classRows.map((r) => (
                          <tr key={r.label}>
                            <td className="px-3 py-2 font-medium text-text">{r.label}</td>
                            <td className="px-3 py-2 font-mono">{r.count}</td>
                            <td className="px-3 py-2 font-mono">{formatSeconds(r.totalSec)}</td>
                            <td className="px-3 py-2 font-mono">{formatSeconds(r.avgDurationSec)}</td>
                            <td className="px-3 py-2 font-mono">{(r.avgConfidence * 100).toFixed(1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>

                <Card className="lg:col-span-3">
                  <CardHeader title="Class distribution" description="Scene count per class." />
                  <BarChart data={classRows.map((r) => ({ label: r.label, value: r.count }))} />
                </Card>

                <Card className="lg:col-span-3">
                  <CardHeader title="Time spent per class" description="Minutes of video attributed to each class." />
                  <BarChart
                    data={classRows.map((r) => ({ label: r.label, value: Math.round((r.totalSec / 60) * 10) / 10 }))}
                  />
                </Card>

                <Card>
                  <CardHeader
                    title="Classification source"
                    description="How each scene's class was decided — the CNN alone, a keyword rule, or CNN+OCR fusion."
                  />
                  <DonutChart
                    data={Object.entries(overviewResult.sourceCounts).map(([key, value]) => ({
                      label: SOURCE_LABELS[key] ?? key,
                      value,
                    }))}
                  />
                </Card>

                <Card className="lg:col-span-3">
                  <CardHeader
                    title="Scenes per video"
                    description="Spot outlier videos that dominate the aggregate numbers above."
                  />
                  <HorizontalBarChart
                    data={overviewResult.perVideo.map((v) => ({ label: v.label, value: v.value, hint: `${v.value} scenes` }))}
                  />
                </Card>
              </>
            )}
          </div>
        ) : tab === "spm" ? (
          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Select videos" description="Frequent sub-sequences across the chosen videos." />
              <ul className="max-h-96 space-y-1 overflow-auto">
                {doneJobs.map((job) => (
                  <li key={job.job_id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-neutral-50">
                      <input
                        type="checkbox"
                        checked={spmSelection.has(job.job_id)}
                        onChange={() => toggleSpm(job.job_id)}
                        className="h-4 w-4"
                      />
                      <span className="truncate text-sm text-text">{job.original_filename}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Parameters" />
              <div className="space-y-4">
                <div>
                  <Label htmlFor="spm-support">Min support (fraction of videos)</Label>
                  <Input
                    id="spm-support"
                    type="number"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={spmMinSupport}
                    onChange={(e) => setSpmMinSupport(Number(e.target.value))}
                  />
                </div>
                <div>
                  <Label htmlFor="spm-topk">Top K patterns</Label>
                  <Input
                    id="spm-topk"
                    type="number"
                    min={1}
                    max={50}
                    value={spmTopK}
                    onChange={(e) => setSpmTopK(Number(e.target.value))}
                  />
                </div>
                <Button className="w-full" onClick={runSpm} loading={spmLoading}>
                  Run SPM
                </Button>
                {spmError && <Alert tone="danger">{spmError}</Alert>}
              </div>
            </Card>

            {spmResults && (
              <Card className="lg:col-span-3">
                <CardHeader title={`Frequent patterns (${spmResults.length})`} />
                {spmResults.length === 0 ? (
                  <p className="text-sm text-neutral-500">No patterns met the minimum support threshold.</p>
                ) : (
                  <HorizontalBarChart
                    data={spmResults.map((r) => ({
                      label: r.pattern.join(" → "),
                      value: r.support_fraction,
                      hint: `${(r.support_fraction * 100).toFixed(0)}%`,
                    }))}
                  />
                )}
              </Card>
            )}
          </div>
        ) : tab === "dsm" ? (
          <div className="grid gap-6 lg:grid-cols-3">
            <Card>
              <CardHeader title="Group A" description={`${groupA.size} selected`} />
              <ul className="max-h-72 space-y-1 overflow-auto">
                {doneJobs.map((job) => (
                  <li key={job.job_id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-neutral-50">
                      <input
                        type="checkbox"
                        checked={groupA.has(job.job_id)}
                        onChange={() => setGroup(job.job_id, groupA.has(job.job_id) ? null : "a")}
                        disabled={groupB.has(job.job_id)}
                        className="h-4 w-4"
                      />
                      <span className="truncate text-sm text-text">{job.original_filename}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Group B" description={`${groupB.size} selected`} />
              <ul className="max-h-72 space-y-1 overflow-auto">
                {doneJobs.map((job) => (
                  <li key={job.job_id}>
                    <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-neutral-50">
                      <input
                        type="checkbox"
                        checked={groupB.has(job.job_id)}
                        onChange={() => setGroup(job.job_id, groupB.has(job.job_id) ? null : "b")}
                        disabled={groupA.has(job.job_id)}
                        className="h-4 w-4"
                      />
                      <span className="truncate text-sm text-text">{job.original_filename}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </Card>

            <Card>
              <CardHeader title="Parameters" />
              <div className="space-y-4">
                <div>
                  <Label htmlFor="dsm-support">Min support</Label>
                  <Input
                    id="dsm-support"
                    type="number"
                    min={0.05}
                    max={1}
                    step={0.05}
                    value={dsmMinSupport}
                    onChange={(e) => setDsmMinSupport(Number(e.target.value))}
                  />
                </div>
                <div>
                  <Label htmlFor="dsm-topk">Top K patterns</Label>
                  <Input
                    id="dsm-topk"
                    type="number"
                    min={1}
                    max={50}
                    value={dsmTopK}
                    onChange={(e) => setDsmTopK(Number(e.target.value))}
                  />
                </div>
                <Button className="w-full" onClick={runDsm} loading={dsmLoading}>
                  Run DSM
                </Button>
                {dsmError && <Alert tone="danger">{dsmError}</Alert>}
              </div>
            </Card>

            {dsmResults && (
              <Card className="lg:col-span-3">
                <CardHeader
                  title={`Differential patterns (${dsmResults.length})`}
                  description="Positive diff = more typical of Group A. Negative diff = more typical of Group B."
                />
                {dsmResults.length === 0 ? (
                  <p className="text-sm text-neutral-500">No differing patterns found at this support threshold.</p>
                ) : (
                  <DivergingBarChart data={dsmResults.map((r) => ({ label: r.pattern.join(" → "), diff: r.diff }))} />
                )}
              </Card>
            )}
          </div>
        ) : (
          <Card>
            <CardHeader title="Video timeline" description="Pick one video to see its scenes laid out over time." />
            <div className="max-w-md">
              <Label htmlFor="timeline-job">Video</Label>
              <Select id="timeline-job" value={timelineJobId} onChange={(e) => loadTimeline(e.target.value)}>
                <option value="">Choose a processed video…</option>
                {doneJobs.map((job) => (
                  <option key={job.job_id} value={job.job_id}>
                    {job.original_filename}
                  </option>
                ))}
              </Select>
            </div>
            {timelineError && (
              <Alert tone="danger" className="mt-4">
                {timelineError}
              </Alert>
            )}
            {timelineLoading && (
              <div className="mt-6">
                <Spinner label="Loading scene log..." />
              </div>
            )}
            {timelineSegments && timelineSegments.length > 0 && (
              <div className="mt-6">
                <GanttTimeline
                  segments={timelineSegments}
                  totalSeconds={Math.max(...timelineSegments.map((s) => s.endSec), 1)}
                />
              </div>
            )}
          </Card>
        )}
      </Container>
    </AppShell>
  );
}

export default function AnalyticsPage() {
  return (
    <ProtectedRoute>
      <AnalyticsContent />
    </ProtectedRoute>
  );
}
