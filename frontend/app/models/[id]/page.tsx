"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { api, ApiError } from "@/lib/api";
import type { ModelOut } from "@/lib/types";
import { ocrExcludedNote } from "@/lib/trainingMetrics";
import { Container, PageHeader } from "@/components/ui/Section";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { MetricsReport } from "@/components/train/MetricsReport";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function ModelDetailContent({ modelId }: { modelId: string }) {
  const [model, setModel] = useState<ModelOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);

  async function load() {
    setError(null);
    try {
      setModel(await api.models.get(modelId));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError("This model doesn't exist or has been removed.");
      } else {
        setError(err instanceof Error ? err.message : "Failed to load model.");
      }
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  async function handleActivate() {
    setActivating(true);
    try {
      await api.models.activate(modelId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to activate model.");
    } finally {
      setActivating(false);
    }
  }

  return (
    <AppShell section="dashboard" crumb="Models">
      <Container className="py-10">
      <Link href="/dashboard" className="mb-4 inline-block text-sm font-medium text-primary hover:underline">
        ← Back to models
      </Link>

      {error && (
        <Alert tone="danger" className="mb-6">
          {error}
        </Alert>
      )}

      {!error && !model && <Spinner label="Loading model..." />}

      {model && (
        <>
          <PageHeader
            eyebrow="Model"
            title={model.name}
            description={`${model.labels.length} classes · created ${formatDate(model.created_at)}`}
            action={
              <div className="flex items-center gap-2">
                {model.is_active ? (
                  <Badge tone="success">active</Badge>
                ) : (
                  <Button onClick={handleActivate} loading={activating}>
                    Set as active
                  </Button>
                )}
                <Link
                  href={`/train?retrainModel=${model.model_id}`}
                  className={buttonClasses({ variant: "outline" })}
                >
                  Retrain with new settings
                </Link>
              </div>
            }
          />

          <div className="grid gap-8 lg:grid-cols-3">
            <div className="lg:col-span-2 space-y-6">
              {model.metrics ? (
                <>
                  <MetricsReport title="CNN-only" metrics={model.metrics.cnn_only} />
                  {model.metrics.text_only && (
                    <MetricsReport title="OCR text-only" metrics={model.metrics.text_only} />
                  )}
                  {model.metrics.combined && (
                    <MetricsReport
                      title={`Combined (fusion α = ${model.metrics.fusion_alpha})`}
                      metrics={model.metrics.combined}
                      note={ocrExcludedNote(model.metrics)}
                    />
                  )}
                  {!model.metrics.combined && (
                    <p className="text-sm text-neutral-500">
                      Not enough legible on-screen text was found to train a text classifier — this model runs
                      CNN-only.
                    </p>
                  )}
                </>
              ) : (
                <Card>
                  <p className="text-sm text-neutral-500">No metrics were recorded for this model.</p>
                </Card>
              )}
            </div>

            <div className="space-y-6">
              <Card>
                <CardHeader title="Classes" />
                <ul className="flex flex-wrap gap-1.5">
                  {model.labels.map((label) => (
                    <Badge key={label} tone="neutral">
                      {label}
                    </Badge>
                  ))}
                </ul>
              </Card>

              <Card>
                <CardHeader title="Details" />
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4">
                    <dt className="text-neutral-500">Status</dt>
                    <dd className="font-medium text-text">{model.is_active ? "Active" : "Inactive"}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-neutral-500">Created</dt>
                    <dd className="font-medium text-text">{formatDate(model.created_at)}</dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-neutral-500">Dataset version</dt>
                    <dd className="font-medium text-text">{model.dataset_version || "—"}</dd>
                  </div>
                  {model.fusion_alpha != null && (
                    <div className="flex justify-between gap-4">
                      <dt className="text-neutral-500">Fusion α</dt>
                      <dd className="font-mono font-medium text-text">{model.fusion_alpha}</dd>
                    </div>
                  )}
                </dl>
              </Card>

              {model.keyword_rules && Object.keys(model.keyword_rules).length > 0 && (
                <Card>
                  <CardHeader title="Keyword rules" description="On-screen text keywords that force a class match." />
                  <dl className="space-y-2 text-sm">
                    {Object.entries(model.keyword_rules).map(([className, keywords]) => (
                      <div key={className}>
                        <dt className="font-medium text-text">{className}</dt>
                        <dd className="text-neutral-500">{keywords.join(", ") || "—"}</dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              )}
            </div>
          </div>
        </>
      )}
      </Container>
    </AppShell>
  );
}

export default function ModelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <ProtectedRoute>
      <ModelDetailContent modelId={id} />
    </ProtectedRoute>
  );
}
