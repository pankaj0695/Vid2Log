"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import type { JobOut, ModelOut, TrainJobOut } from "@/lib/types";
import { Container, PageHeader } from "@/components/ui/Section";
import { StatCard } from "@/components/ui/StatCard";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button, buttonClasses } from "@/components/ui/Button";
import { StatusBadge, Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { Sparkline } from "@/components/ui/charts";

type Tab = "overview" | "models" | "activity";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

/** Buckets a list of ISO timestamps into counts-per-day for the last N days
 * — real data (nothing fabricated), used for the one sparkline on this page
 * that actually has a time series behind it. */
function dailyCounts(isoDates: (string | null)[], days: number): number[] {
  const buckets = new Array(days).fill(0);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (const iso of isoDates) {
    if (!iso) continue;
    const d = new Date(iso);
    const dayIndex = days - 1 - Math.floor((startOfToday.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
    if (dayIndex >= 0 && dayIndex < days) buckets[dayIndex] += 1;
  }
  return buckets;
}

function DashboardContent() {
  const { profile } = useAuth();
  const [tab, setTab] = useState<Tab>("overview");

  const [jobs, setJobs] = useState<JobOut[] | null>(null);
  const [models, setModels] = useState<ModelOut[] | null>(null);
  const [trainingJobs, setTrainingJobs] = useState<TrainJobOut[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    try {
      const [j, m, t] = await Promise.all([api.jobs.list(50), api.models.list(), api.train.list(50)]);
      setJobs(j);
      setModels(m);
      setTrainingJobs(t);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load your data.");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  const done = jobs?.filter((j) => j.status === "done").length ?? 0;
  const active = jobs?.filter((j) => j.status === "queued" || j.status === "processing").length ?? 0;
  const jobsPerDay = useMemo(() => (jobs ? dailyCounts(jobs.map((j) => j.created_at), 14) : []), [jobs]);

  async function handleActivate(modelId: string) {
    setActivatingId(modelId);
    try {
      await api.models.activate(modelId);
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to activate model.");
    } finally {
      setActivatingId(null);
    }
  }

  const activityFeed = useMemo(() => {
    if (!jobs || !trainingJobs) return null;
    const items = [
      ...jobs.map((j) => ({
        kind: "video" as const,
        id: j.job_id,
        title: j.original_filename,
        status: j.status as string,
        created_at: j.created_at,
      })),
      ...trainingJobs.map((t) => ({
        kind: "training" as const,
        id: t.training_job_id,
        title: t.model_name,
        status: t.status as string,
        created_at: t.created_at,
      })),
    ];
    items.sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime());
    return items.slice(0, 20);
  }, [jobs, trainingJobs]);

  return (
    <AppShell section="dashboard" crumb="Dashboard">
      <Container className="py-10">
        <PageHeader
          eyebrow="Dashboard"
          title={`Welcome${profile?.display_name ? `, ${profile.display_name.split(" ")[0]}` : ""}`}
          description="What's happening across your models and video jobs."
          action={
            <Link href="/process" className={buttonClasses({ variant: "primary" })}>
              Process a video
            </Link>
          }
        />

        <Tabs
          tabs={[
            { id: "overview", label: "Overview" },
            { id: "models", label: "Models" },
            { id: "activity", label: "Activity" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {loadError && (
          <div className="mb-6 rounded-lg border border-danger/20 bg-danger-tint px-4 py-3 text-sm text-danger">
            {loadError}
          </div>
        )}

        {jobs === null ? (
          <div className="flex justify-center py-16">
            <Spinner label="Loading your dashboard..." />
          </div>
        ) : tab === "overview" ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card className="p-6">
                <p className="text-sm font-medium text-neutral-500">Total jobs</p>
                <p className="mt-2 font-mono text-4xl font-semibold text-text">{jobs.length}</p>
                {jobsPerDay.some((n) => n > 0) && (
                  <div className="mt-3">
                    <Sparkline data={jobsPerDay} height={32} />
                  </div>
                )}
              </Card>
              <StatCard label="Completed" value={done} />
              <StatCard label="In progress" value={active} />
              <StatCard label="Trained / registered models" value={models?.length ?? "—"} />
            </div>

            <div className="mt-10 grid gap-6 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <CardHeader
                  title="Recent jobs"
                  description="Your most recently submitted video-processing jobs."
                  action={
                    <Link href="/process" className="text-sm font-medium text-primary hover:underline">
                      View all
                    </Link>
                  }
                />
                {jobs.length === 0 ? (
                  <EmptyState
                    title="No videos processed yet"
                    description="Upload a screen recording and pick a trained model to generate your first log."
                    action={
                      <Link href="/process" className={buttonClasses({ variant: "primary", size: "sm" })}>
                        Process a video
                      </Link>
                    }
                  />
                ) : (
                  <ul className="divide-y divide-neutral-100">
                    {jobs.slice(0, 8).map((job) => (
                      <li key={job.job_id} className="flex items-center justify-between gap-4 py-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-text">{job.original_filename}</p>
                          <p className="text-sm text-neutral-500">
                            {job.scene_count != null ? `${job.scene_count} scenes` : "—"}
                          </p>
                        </div>
                        <StatusBadge status={job.status} />
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card>
                <CardHeader title="Quick actions" />
                <div className="space-y-2">
                  <Link href="/train" className={buttonClasses({ variant: "outline", className: "w-full justify-start" })}>
                    Train a new model
                  </Link>
                  <Link
                    href="/process"
                    className={buttonClasses({ variant: "outline", className: "w-full justify-start" })}
                  >
                    Process a video
                  </Link>
                  <Link
                    href="/analytics"
                    className={buttonClasses({ variant: "outline", className: "w-full justify-start" })}
                  >
                    Run pattern analysis
                  </Link>
                </div>
                <div className="mt-6 border-t border-neutral-100 pt-4">
                  <Button variant="ghost" size="sm" onClick={load}>
                    Refresh
                  </Button>
                </div>
              </Card>
            </div>
          </>
        ) : tab === "models" ? (
          <Card>
            <CardHeader
              title="Model registry"
              description="Every model you've trained. Activate the one new video jobs should use by default."
            />
            {models === null ? (
              <Spinner label="Loading models..." />
            ) : models.length === 0 ? (
              <EmptyState
                title="No models yet"
                description="Train your first model to see it here."
                action={
                  <Link href="/train" className={buttonClasses({ variant: "primary", size: "sm" })}>
                    Train a model
                  </Link>
                }
              />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {models.map((m) => (
                  <li key={m.model_id} className="rounded-lg border border-neutral-200 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text">{m.name}</p>
                        <p className="text-sm text-neutral-500">{m.labels.length} classes</p>
                      </div>
                      {m.is_active && <Badge tone="success">active</Badge>}
                    </div>
                    {m.metrics?.cnn_only && (
                      <p className="mt-1 font-mono text-sm text-neutral-500">
                        test acc {(m.metrics.cnn_only.accuracy * 100).toFixed(1)}%
                      </p>
                    )}
                    <div className="mt-3 flex gap-2">
                      <Link
                        href={`/models/${m.model_id}`}
                        className={buttonClasses({ variant: "outline", size: "sm", className: "flex-1" })}
                      >
                        View details
                      </Link>
                      {!m.is_active && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1"
                          onClick={() => handleActivate(m.model_id)}
                          loading={activatingId === m.model_id}
                        >
                          Activate
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ) : (
          <Card>
            <CardHeader title="Activity" description="Every video and training job, merged and time-ordered." />
            {activityFeed === null ? (
              <Spinner label="Loading activity..." />
            ) : activityFeed.length === 0 ? (
              <EmptyState title="No activity yet" description="Train a model or process a video to see it here." />
            ) : (
              <ul className="divide-y divide-neutral-100">
                {activityFeed.map((item) => (
                  <li key={`${item.kind}-${item.id}`} className="flex items-center justify-between gap-4 py-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <Badge tone={item.kind === "video" ? "primary" : "secondary"}>
                        {item.kind === "video" ? "Video" : "Training"}
                      </Badge>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text">{item.title}</p>
                        <p className="text-sm text-neutral-500">{formatDate(item.created_at)}</p>
                      </div>
                    </div>
                    <StatusBadge status={item.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </Container>
    </AppShell>
  );
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <DashboardContent />
    </ProtectedRoute>
  );
}
