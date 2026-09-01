"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { api } from "@/lib/api";
import type { ModelOut } from "@/lib/types";
import { Container, PageHeader } from "@/components/ui/Section";
import { Card } from "@/components/ui/Card";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SkeletonCard } from "@/components/ui/Skeleton";
import { Tooltip } from "@/components/ui/Tooltip";
import { PAGE_SUBTITLES, BUTTON_TOOLTIPS } from "@/lib/copy";
import { HELP_ANCHORS } from "@/lib/helpContent";

function stagger(index: number, stepMs = 50): CSSProperties {
  return { "--stagger": `${index * stepMs}ms` } as CSSProperties;
}

/** Every detector you've trained, moved out of Train's old tab into its own
 * page — activating, renaming, and deleting detectors is a distinct enough
 * job from actually training one that it deserves its own spot in the
 * sidebar rather than living behind a tab. Lives at /detectors; the backend
 * still calls these "models" (api.models.*), which is deliberate — the
 * rename is user-facing vocabulary only, the API contract is unchanged. */
function ModelsContent() {
  const [models, setModels] = useState<ModelOut[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  const [renamingModelId, setRenamingModelId] = useState<string | null>(null);
  const [renameModelValue, setRenameModelValue] = useState("");
  const [renameModelBusy, setRenameModelBusy] = useState(false);
  const [renameModelError, setRenameModelError] = useState<string | null>(null);

  const [deleteModelTarget, setDeleteModelTarget] = useState<ModelOut | null>(null);
  const [deleteModelBusy, setDeleteModelBusy] = useState(false);

  async function loadModels() {
    setModelsError(null);
    try {
      setModels(await api.models.list());
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : "Failed to load your detectors.");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadModels();
  }, []);

  async function handleActivate(modelId: string) {
    setActivatingId(modelId);
    try {
      await api.models.activate(modelId);
      await loadModels();
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : "Failed to activate detector.");
    } finally {
      setActivatingId(null);
    }
  }

  function startRenameModel(model: ModelOut) {
    setRenamingModelId(model.model_id);
    setRenameModelValue(model.name);
    setRenameModelError(null);
  }

  function cancelRenameModel() {
    setRenamingModelId(null);
    setRenameModelError(null);
  }

  async function commitRenameModel(modelId: string) {
    const name = renameModelValue.trim();
    if (!name) {
      setRenameModelError("Name can't be empty.");
      return;
    }
    setRenameModelBusy(true);
    try {
      await api.models.rename(modelId, name);
      setRenamingModelId(null);
      await loadModels();
    } catch (err) {
      setRenameModelError(err instanceof Error ? err.message : "Failed to rename.");
    } finally {
      setRenameModelBusy(false);
    }
  }

  async function confirmDeleteModel() {
    if (!deleteModelTarget) return;
    setDeleteModelBusy(true);
    try {
      await api.models.remove(deleteModelTarget.model_id);
      setDeleteModelTarget(null);
      await loadModels();
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : "Failed to delete detector.");
    } finally {
      setDeleteModelBusy(false);
    }
  }

  return (
    <AppShell section="detectors" crumb="Detectors">
      <Container className="py-10">
        <PageHeader
          eyebrow="Detectors"
          subtitle={PAGE_SUBTITLES.detectors}
          title="My detectors"
          helpAnchor={HELP_ANCHORS.detectors}
          action={
            <Link href="/train" className={buttonClasses({ variant: "primary" })}>
              Train a detector
            </Link>
          }
        />

        <Card>
          {modelsError && (
            <Alert tone="danger" className="mb-3">
              {modelsError}
            </Alert>
          )}
          {models === null ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="animate-fade-in-up" style={stagger(i)}>
                  <SkeletonCard />
                </div>
              ))}
            </div>
          ) : models.length === 0 ? (
            <EmptyState
              title="No detectors yet"
              action={
                <Link href="/train" className={buttonClasses({ variant: "primary", size: "sm" })}>
                  Train a detector
                </Link>
              }
            />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {models.map((m, i) => (
                <li
                  key={m.model_id}
                  className="hover-lift animate-fade-in-up rounded-lg border border-neutral-200 p-4"
                  style={stagger(i)}
                >
                  {renamingModelId === m.model_id ? (
                    <div>
                      <Input
                        autoFocus
                        value={renameModelValue}
                        onChange={(e) => setRenameModelValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRenameModel(m.model_id);
                          if (e.key === "Escape") cancelRenameModel();
                        }}
                      />
                      {renameModelError && <p className="mt-1 text-sm text-danger">{renameModelError}</p>}
                      <div className="mt-2 flex gap-2">
                        <Button
                          size="sm"
                          className="flex-1"
                          onClick={() => commitRenameModel(m.model_id)}
                          loading={renameModelBusy}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="flex-1"
                          onClick={cancelRenameModel}
                          disabled={renameModelBusy}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-text">{m.name}</p>
                          <p className="text-sm text-neutral-500">{m.labels.length} actions</p>
                        </div>
                        {m.is_active && <Badge tone="success">active</Badge>}
                      </div>
                      {m.metrics?.cnn_only && (
                        <p className="mt-1 font-mono text-sm text-neutral-500">
                          test acc {(m.metrics.cnn_only.accuracy * 100).toFixed(1)}%
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Link
                          href={`/detectors/${m.model_id}`}
                          className={buttonClasses({ variant: "outline", size: "sm", className: "flex-1" })}
                        >
                          View details
                        </Link>
                        {!m.is_active && (
                          <Tooltip label={BUTTON_TOOLTIPS.activate} wrapperClassName="flex-1">
                            <Button
                              size="sm"
                              variant="outline"
                              className="w-full"
                              onClick={() => handleActivate(m.model_id)}
                              loading={activatingId === m.model_id}
                            >
                              Set as active
                            </Button>
                          </Tooltip>
                        )}
                      </div>
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" variant="outline" className="flex-1" onClick={() => startRenameModel(m)}>
                          Rename
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          className="flex-1"
                          onClick={() => setDeleteModelTarget(m)}
                        >
                          Delete
                        </Button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Container>

      <ConfirmDialog
        open={deleteModelTarget !== null}
        title="Delete this detector?"
        description={
          deleteModelTarget && (
            <>
              This permanently deletes <span className="font-medium text-text">{deleteModelTarget.name}</span> and its
              saved files. This can&apos;t be undone.
              {deleteModelTarget.is_active && (
                <p className="mt-2 text-warning">
                  This is your currently active detector — new recordings will have no default detector until you
                  activate another one.
                </p>
              )}
            </>
          )
        }
        confirmLabel="Delete detector"
        busy={deleteModelBusy}
        onConfirm={confirmDeleteModel}
        onCancel={() => setDeleteModelTarget(null)}
      />
    </AppShell>
  );
}

export default function ModelsPage() {
  return (
    <ProtectedRoute>
      <ModelsContent />
    </ProtectedRoute>
  );
}
