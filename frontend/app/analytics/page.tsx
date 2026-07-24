"use client";

import { useEffect, useMemo, useState } from "react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { api } from "@/lib/api";
import { downloadCsv, downloadMultiSectionCsv } from "@/lib/csv";
import { downloadOverviewPdf } from "@/lib/pdfReport";
import type { DSMPattern, DSMTestType, JobOut, LogOut, SPMPattern, SPMSortBy } from "@/lib/types";
import { Container, PageHeader } from "@/components/ui/Section";
import { Card, CardHeader } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { BarChart, DonutChart, HorizontalBarChart, GanttTimeline } from "@/components/ui/charts";

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
  const [spmMinSupport, setSpmMinSupport] = useState(0.4);
  const [spmTopK, setSpmTopK] = useState(10);
  const [spmResults, setSpmResults] = useState<SPMPattern[] | null>(null);
  const [spmLoading, setSpmLoading] = useState(false);
  const [spmError, setSpmError] = useState<string | null>(null);
  // SPM Advanced options — defaults mirror backend/app/schemas.py::SPMRequest.
  const [spmShowAdvanced, setSpmShowAdvanced] = useState(false);
  const [spmSlidingWindowMin, setSpmSlidingWindowMin] = useState(1);
  const [spmSlidingWindowMax, setSpmSlidingWindowMax] = useState(4);
  const [spmMinGap, setSpmMinGap] = useState(0);
  const [spmMaxGap, setSpmMaxGap] = useState<number | "">(12);
  const [spmMinInstanceSupport, setSpmMinInstanceSupport] = useState(0);
  const [spmSortBy, setSpmSortBy] = useState<SPMSortBy>("s_support");

  // DSM state
  const [groupA, setGroupA] = useState<Set<string>>(new Set());
  const [groupB, setGroupB] = useState<Set<string>>(new Set());
  const [dsmMinSupport, setDsmMinSupport] = useState(0.4);
  const [dsmTopK, setDsmTopK] = useState(10);
  const [dsmResults, setDsmResults] = useState<DSMPattern[] | null>(null);
  const [dsmLoading, setDsmLoading] = useState(false);
  const [dsmError, setDsmError] = useState<string | null>(null);
  // DSM Advanced options — the shared mining-engine fields mirror SPM's
  // (see backend/app/schemas.py::DSMRequest); test_type/threshold_p_value
  // are DSM-specific (statistical significance between the two groups).
  const [dsmShowAdvanced, setDsmShowAdvanced] = useState(false);
  const [dsmSlidingWindowMin, setDsmSlidingWindowMin] = useState(1);
  const [dsmSlidingWindowMax, setDsmSlidingWindowMax] = useState(4);
  const [dsmMinGap, setDsmMinGap] = useState(0);
  const [dsmMaxGap, setDsmMaxGap] = useState<number | "">(12);
  const [dsmMinInstanceSupport, setDsmMinInstanceSupport] = useState(0);
  const [dsmTestType, setDsmTestType] = useState<DSMTestType>("ttest_ind");
  const [dsmThresholdPValue, setDsmThresholdPValue] = useState(0.1);

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

  function downloadOverviewCsv() {
    if (!overviewResult) return;
    downloadMultiSectionCsv("analytics_overview_report.csv", [
      {
        title: "Summary",
        headers: ["Videos analyzed", "Total scenes", "Total duration", "Avg. confidence"],
        rows: [
          [
            overviewResult.videoCount,
            overviewResult.totalScenes,
            formatSeconds(overviewResult.totalDurationSec),
            `${(overviewResult.avgConfidence * 100).toFixed(1)}%`,
          ],
        ],
      },
      {
        title: "Per-class summary",
        headers: ["Class", "Scenes", "Total time (s)", "Avg. scene length (s)", "Avg. confidence"],
        rows: classRows.map((r) => [
          r.label,
          r.count,
          r.totalSec.toFixed(1),
          r.avgDurationSec.toFixed(1),
          `${(r.avgConfidence * 100).toFixed(1)}%`,
        ]),
      },
      {
        title: "Scenes per video",
        headers: ["Video", "Scenes"],
        rows: overviewResult.perVideo.map((v) => [v.label, v.value]),
      },
      {
        title: "Classification source",
        headers: ["Source", "Count"],
        rows: Object.entries(overviewResult.sourceCounts).map(([key, value]) => [SOURCE_LABELS[key] ?? key, value]),
      },
    ]);
  }

  function downloadOverviewPdfReport() {
    if (!overviewResult) return;
    downloadOverviewPdf({
      generatedAt: new Date(),
      videoCount: overviewResult.videoCount,
      totalScenes: overviewResult.totalScenes,
      totalDurationLabel: formatSeconds(overviewResult.totalDurationSec),
      avgConfidencePct: `${(overviewResult.avgConfidence * 100).toFixed(1)}%`,
      classRows,
      perVideo: overviewResult.perVideo,
      sourceCounts: Object.entries(overviewResult.sourceCounts).map(([key, value]) => ({
        label: SOURCE_LABELS[key] ?? key,
        value,
      })),
      formatSeconds,
    });
  }

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
        sliding_window_min: spmSlidingWindowMin,
        sliding_window_max: spmSlidingWindowMax,
        min_gap: spmMinGap,
        max_gap: spmMaxGap === "" ? null : spmMaxGap,
        min_instance_support: spmMinInstanceSupport,
        sort_by: spmSortBy,
      });
      setSpmResults(results);
    } catch (err) {
      setSpmError(err instanceof Error ? err.message : "Failed to run pattern mining.");
    } finally {
      setSpmLoading(false);
    }
  }

  // Matches the reference SPM tool's export format: Pattern uses "--->" as
  // the step separator, column order is Pattern/I-Frequency/S-Frequency/
  // I-Support (mean)/S-Support/I-Support (sd).
  function downloadSpmCsv() {
    if (!spmResults || spmResults.length === 0) return;
    downloadCsv(
      "spm_results.csv",
      ["Pattern", "I-Frequency", "S-Frequency", "I-Support (mean)", "S-Support", "I-Support (sd)"],
      spmResults.map((r) => [
        r.pattern.join("--->"),
        r.i_frequency,
        r.support,
        r.i_support_mean.toFixed(6),
        r.support_fraction.toFixed(6),
        r.i_support_sd.toFixed(6),
      ])
    );
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
        sliding_window_min: dsmSlidingWindowMin,
        sliding_window_max: dsmSlidingWindowMax,
        min_gap: dsmMinGap,
        max_gap: dsmMaxGap === "" ? null : dsmMaxGap,
        min_instance_support: dsmMinInstanceSupport,
        test_type: dsmTestType,
        threshold_p_value: dsmThresholdPValue,
      });
      setDsmResults(results);
    } catch (err) {
      setDsmError(err instanceof Error ? err.message : "Failed to run differential mining.");
    } finally {
      setDsmLoading(false);
    }
  }

  // Matches the reference DSM tool's export format exactly, including its
  // "ttest_value" column name regardless of which test was actually run.
  function downloadDsmCsv() {
    if (!dsmResults || dsmResults.length === 0) return;
    downloadCsv(
      "dsm_results.csv",
      ["pattern", "ttest_value", "isupportleft_mean", "isupportright_mean", "Group"],
      dsmResults.map((r) => [
        r.pattern.join("--->"),
        r.p_value,
        r.isupport_left_mean === null ? "" : r.isupport_left_mean.toFixed(6),
        r.isupport_right_mean === null ? "" : r.isupport_right_mean.toFixed(6),
        r.group,
      ])
    );
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
          description="See what your processed videos actually contain - class distribution, common workflows, what differs between groups, and one video at a time."
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
                <div className="flex flex-wrap items-center justify-between gap-3 lg:col-span-3">
                  <p className="text-sm text-neutral-500">Download this report as a spreadsheet or a formatted PDF.</p>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={downloadOverviewCsv}>
                      Download CSV
                    </Button>
                    <Button variant="outline" size="sm" onClick={downloadOverviewPdfReport}>
                      Download PDF
                    </Button>
                  </div>
                </div>

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
                  <Label htmlFor="spm-support">S Support Threshold (fraction of videos)</Label>
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
                <div>
                  <Label htmlFor="spm-sortby">Sort by</Label>
                  <Select
                    id="spm-sortby"
                    value={spmSortBy}
                    onChange={(e) => setSpmSortBy(e.target.value as SPMSortBy)}
                  >
                    <option value="s_support">S-Support</option>
                    <option value="i_support">I-Support</option>
                  </Select>
                </div>

                <button
                  type="button"
                  onClick={() => setSpmShowAdvanced((v) => !v)}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {spmShowAdvanced ? "− Hide advanced options" : "+ Advanced options"}
                </button>

                {spmShowAdvanced && (
                  <div className="grid gap-4 border-t border-neutral-100 pt-4 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="spm-window-min">Sliding Window Min</Label>
                      <Input
                        id="spm-window-min"
                        type="number"
                        min={1}
                        max={20}
                        value={spmSlidingWindowMin}
                        onChange={(e) => setSpmSlidingWindowMin(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="spm-window-max">Sliding Window Max</Label>
                      <Input
                        id="spm-window-max"
                        type="number"
                        min={1}
                        max={20}
                        value={spmSlidingWindowMax}
                        onChange={(e) => setSpmSlidingWindowMax(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="spm-min-gap">Min Gap</Label>
                      <Input
                        id="spm-min-gap"
                        type="number"
                        min={0}
                        value={spmMinGap}
                        onChange={(e) => setSpmMinGap(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="spm-max-gap">Max Gap (blank = unlimited)</Label>
                      <Input
                        id="spm-max-gap"
                        type="number"
                        min={0}
                        value={spmMaxGap}
                        onChange={(e) => setSpmMaxGap(e.target.value === "" ? "" : Number(e.target.value))}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="spm-i-support">I Support Threshold (min avg occurrences/video)</Label>
                      <Input
                        id="spm-i-support"
                        type="number"
                        min={0}
                        step={0.1}
                        value={spmMinInstanceSupport}
                        onChange={(e) => setSpmMinInstanceSupport(Number(e.target.value))}
                      />
                    </div>
                  </div>
                )}

                <Button className="w-full" onClick={runSpm} loading={spmLoading}>
                  Run SPM
                </Button>
                {spmError && <Alert tone="danger">{spmError}</Alert>}
              </div>
            </Card>

            {spmResults && (
              <Card className="lg:col-span-3">
                <CardHeader
                  title={`Frequent patterns (${spmResults.length})`}
                  action={
                    spmResults.length > 0 && (
                      <Button variant="outline" size="sm" onClick={downloadSpmCsv}>
                        Download CSV
                      </Button>
                    )
                  }
                />
                {spmResults.length === 0 ? (
                  <p className="text-sm text-neutral-500">No patterns met the minimum support threshold.</p>
                ) : (
                  <>
                    <HorizontalBarChart
                      data={spmResults.map((r) => ({
                        label: r.pattern.join(" → "),
                        value: spmSortBy === "i_support" ? r.i_support_mean : r.support_fraction,
                        hint:
                          spmSortBy === "i_support"
                            ? r.i_support_mean.toFixed(2)
                            : `${(r.support_fraction * 100).toFixed(0)}%`,
                      }))}
                    />
                    <div className="mt-6 overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-neutral-200 text-neutral-500">
                            <th className="py-2 pr-4 font-medium">Pattern</th>
                            <th className="py-2 pr-4 font-medium">I-Frequency</th>
                            <th className="py-2 pr-4 font-medium">S-Frequency</th>
                            <th className="py-2 pr-4 font-medium">I-Support (mean)</th>
                            <th className="py-2 pr-4 font-medium">S-Support</th>
                            <th className="py-2 pr-4 font-medium">I-Support (sd)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {spmResults.map((r, i) => (
                            <tr key={i} className="border-b border-neutral-100 last:border-0">
                              <td className="max-w-xs break-words py-2 pr-4 font-mono text-xs">
                                {r.pattern.join(" ---> ")}
                              </td>
                              <td className="py-2 pr-4">{r.i_frequency}</td>
                              <td className="py-2 pr-4">{r.support}</td>
                              <td className="py-2 pr-4">{r.i_support_mean.toFixed(2)}</td>
                              <td className="py-2 pr-4">{r.support_fraction.toFixed(2)}</td>
                              <td className="py-2 pr-4">{r.i_support_sd.toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
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
                  <Label htmlFor="dsm-support">S Support Threshold</Label>
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
                <div>
                  <Label htmlFor="dsm-test-type">Test Type</Label>
                  <Select
                    id="dsm-test-type"
                    value={dsmTestType}
                    onChange={(e) => setDsmTestType(e.target.value as DSMTestType)}
                  >
                    <option value="ttest_ind">ttest_ind</option>
                    <option value="poisson_means_test">poisson_means_test</option>
                    <option value="mannwhitneyu">mannwhitneyu</option>
                    <option value="bws_test">bws_test</option>
                    <option value="ranksums">ranksums</option>
                    <option value="brunnermunzel">brunnermunzel</option>
                    <option value="mood">mood</option>
                    <option value="ansari">ansari</option>
                    <option value="cramervonmises_2samp">cramervonmises_2samp</option>
                    <option value="epps_singleton_2samp">epps_singleton_2samp</option>
                    <option value="ks_2samp">ks_2samp</option>
                    <option value="kstest">kstest</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="dsm-p-threshold">Threshold P-value</Label>
                  <Input
                    id="dsm-p-threshold"
                    type="number"
                    min={0.001}
                    max={1}
                    step={0.01}
                    value={dsmThresholdPValue}
                    onChange={(e) => setDsmThresholdPValue(Number(e.target.value))}
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setDsmShowAdvanced((v) => !v)}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {dsmShowAdvanced ? "− Hide advanced options" : "+ Advanced options"}
                </button>

                {dsmShowAdvanced && (
                  <div className="grid gap-4 border-t border-neutral-100 pt-4 sm:grid-cols-2">
                    <div>
                      <Label htmlFor="dsm-window-min">Sliding Window Min</Label>
                      <Input
                        id="dsm-window-min"
                        type="number"
                        min={1}
                        max={20}
                        value={dsmSlidingWindowMin}
                        onChange={(e) => setDsmSlidingWindowMin(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="dsm-window-max">Sliding Window Max</Label>
                      <Input
                        id="dsm-window-max"
                        type="number"
                        min={1}
                        max={20}
                        value={dsmSlidingWindowMax}
                        onChange={(e) => setDsmSlidingWindowMax(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="dsm-min-gap">Min Gap</Label>
                      <Input
                        id="dsm-min-gap"
                        type="number"
                        min={0}
                        value={dsmMinGap}
                        onChange={(e) => setDsmMinGap(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="dsm-max-gap">Max Gap (blank = unlimited)</Label>
                      <Input
                        id="dsm-max-gap"
                        type="number"
                        min={0}
                        value={dsmMaxGap}
                        onChange={(e) => setDsmMaxGap(e.target.value === "" ? "" : Number(e.target.value))}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="dsm-i-support">I Support Threshold (min avg occurrences/video)</Label>
                      <Input
                        id="dsm-i-support"
                        type="number"
                        min={0}
                        step={0.1}
                        value={dsmMinInstanceSupport}
                        onChange={(e) => setDsmMinInstanceSupport(Number(e.target.value))}
                      />
                    </div>
                  </div>
                )}

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
                  description={`Patterns whose per-video occurrence rate differs significantly (p ≤ ${dsmThresholdPValue}) between Group A ("left") and Group B ("right"), via ${dsmTestType}.`}
                  action={
                    dsmResults.length > 0 && (
                      <Button variant="outline" size="sm" onClick={downloadDsmCsv}>
                        Download CSV
                      </Button>
                    )
                  }
                />
                {dsmResults.length === 0 ? (
                  <p className="text-sm text-neutral-500">No significantly differing patterns found at this threshold.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-neutral-200 text-neutral-500">
                          <th className="py-2 pr-4 font-medium">Pattern</th>
                          <th className="py-2 pr-4 font-medium">p-value</th>
                          <th className="py-2 pr-4 font-medium">I-Support left mean</th>
                          <th className="py-2 pr-4 font-medium">I-Support right mean</th>
                          <th className="py-2 pr-4 font-medium">Group</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dsmResults.map((r, i) => (
                          <tr key={i} className="border-b border-neutral-100 last:border-0">
                            <td className="max-w-xs break-words py-2 pr-4 font-mono text-xs">
                              {r.pattern.join(" ---> ")}
                            </td>
                            <td className="py-2 pr-4">{r.p_value.toExponential(2)}</td>
                            <td className="py-2 pr-4">{r.isupport_left_mean === null ? "—" : r.isupport_left_mean.toFixed(2)}</td>
                            <td className="py-2 pr-4">{r.isupport_right_mean === null ? "—" : r.isupport_right_mean.toFixed(2)}</td>
                            <td className="py-2 pr-4 capitalize">{r.group}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
                  height={80}
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
