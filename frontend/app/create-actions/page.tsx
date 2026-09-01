"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { api } from "@/lib/api";
import { uploadToGCS } from "@/lib/gcs";
import type { ActionDatasetOut, ActionDiscoveryJobOut } from "@/lib/types";
import { Container, PageHeader } from "@/components/ui/Section";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { StatusBadge, Badge } from "@/components/ui/Badge";
import { ProgressBar, IndeterminateProgressBar } from "@/components/ui/ProgressBar";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";
import { Tooltip } from "@/components/ui/Tooltip";
import { PAGE_SUBTITLES, TAB_TOOLTIPS, BUTTON_TOOLTIPS, FIELD_TOOLTIPS } from "@/lib/copy";
import { HELP_ANCHORS } from "@/lib/helpContent";

function stagger(index: number, stepMs = 45): CSSProperties {
  return { "--stagger": `${index * stepMs}ms` } as CSSProperties;
}

let idCounter = 0;
function newId() {
  idCounter += 1;
  return `action-${idCounter}-${Date.now()}`;
}

// One image inside an action being reviewed — exactly one "source":
//   - "discover": a preview frame still sitting in a discovery job's own
//     temp Cloud Storage prefix (clusterId + frameId).
//   - "dataset": an image an already-SAVED dataset already has, at its
//     current position (datasetClassIndex + datasetImageIndex) — only
//     appears when editing a saved dataset, never a fresh discovery job.
//   - "upload": a freshly-uploaded manual addition (storagePath), the one
//     source shared by both discover and edit modes.
// previewUrl is always a ready-to-render blob object URL: fetched eagerly
// through the authed API for "discover"/"dataset" sources (there's no public
// URL to just drop into an <img src>), or built straight from the File the
// moment it's chosen for "upload".
interface ActionImageDraft {
  key: string;
  source: "discover" | "dataset" | "upload";
  clusterId?: string;
  frameId?: string;
  datasetClassIndex?: number;
  datasetImageIndex?: number;
  storagePath?: string;
  previewUrl: string;
}

interface ActionClassDraft {
  id: string;
  name: string;
  images: ActionImageDraft[];
  // Set only while this card's images are still streaming in from
  // openReview/openEditDataset — how many more are expected, so the grid can
  // show that many skeleton tiles instead of misreporting "no images yet."
  // Absent (or 0) once loading is done or for any manually-created action.
  pendingImages?: number;
}

type MainTab = "discover" | "saved";
type ReviewMode = "discover" | "edit" | null;

const STAGE_LABELS: Record<string, string> = {
  starting: "Starting",
  sampling: "Sampling frames",
  embedding: "Computing visual embeddings",
  clustering: "Clustering similar frames",
  uploading_previews: "Uploading previews",
};

// The backend doesn't report a numeric percent within a stage, but the
// stages always run in this fixed order — mapping each one to a fraction
// still gives a real, steadily-advancing progress bar instead of an
// unhelpful spinner, it just jumps between known checkpoints rather than
// animating continuously.
const STAGE_FRACTIONS: Record<string, number> = {
  starting: 0.06,
  sampling: 0.28,
  embedding: 0.58,
  clustering: 0.8,
  uploading_previews: 0.93,
};

function progressLabel(progress: ActionDiscoveryJobOut["progress"]): string | null {
  if (!progress) return null;
  const base = STAGE_LABELS[progress.stage] || progress.stage;
  return progress.detail ? `${base} — ${progress.detail}` : `${base}…`;
}

function progressFraction(stage: string): number {
  return STAGE_FRACTIONS[stage] ?? 0.5;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function revokePreviewUrls(classes: ActionClassDraft[]) {
  for (const cls of classes) {
    for (const img of cls.images) URL.revokeObjectURL(img.previewUrl);
  }
}

function CreateActionsContent() {
  const [tab, setTab] = useState<MainTab>("discover");

  // ── Upload + start discovery ──────────────────────────────────────────
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [fps, setFps] = useState(2);
  const [minClusterSize, setMinClusterSize] = useState(5);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // The job just started from this page — watched so review opens
  // automatically the moment it finishes, no extra click needed.
  const [autoOpenJobId, setAutoOpenJobId] = useState<string | null>(null);

  // ── Discovery job history ───────────────────────────────────────────────
  const [jobs, setJobs] = useState<ActionDiscoveryJobOut[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);

  // ── Review/edit mode — one shared UI for "reviewing a just-finished
  // discovery job" and "editing an already-saved dataset". ────────────────
  const [reviewMode, setReviewMode] = useState<ReviewMode>(null);
  const [reviewSourceId, setReviewSourceId] = useState<string | null>(null);
  const [reviewSourceLabel, setReviewSourceLabel] = useState<string>("");
  const [classes, setClasses] = useState<ActionClassDraft[]>([]);
  const [selectedForMerge, setSelectedForMerge] = useState<Set<string>>(new Set());
  const [datasetName, setDatasetName] = useState("");
  const [uploadingClassId, setUploadingClassId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null);
  // Drag-to-move-between-actions — `draggedImage` is set on drag start and
  // read by whichever action card the pointer is released over, regardless
  // of that image's source (discover/dataset/upload) or its position.
  const [draggedImage, setDraggedImage] = useState<{ classId: string; key: string } | null>(null);
  const [dragOverClassId, setDragOverClassId] = useState<string | null>(null);

  // ── Saved datasets ───────────────────────────────────────────────────────
  const [datasets, setDatasets] = useState<ActionDatasetOut[] | null>(null);
  const [datasetsError, setDatasetsError] = useState<string | null>(null);
  const [expandedDatasetId, setExpandedDatasetId] = useState<string | null>(null);
  // null = that slot's fetch hasn't resolved yet — see toggleExpandDataset.
  const [datasetPreviews, setDatasetPreviews] = useState<Record<string, (string | null)[][]>>({});
  const [deleteDatasetTarget, setDeleteDatasetTarget] = useState<ActionDatasetOut | null>(null);
  const [deleteDatasetBusy, setDeleteDatasetBusy] = useState(false);

  async function loadJobs() {
    setJobsError(null);
    try {
      setJobs(await api.actions.listDiscoveryJobs());
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Failed to load discovery jobs.");
    }
  }

  async function loadDatasets() {
    setDatasetsError(null);
    try {
      setDatasets(await api.actions.listDatasets());
    } catch (err) {
      setDatasetsError(err instanceof Error ? err.message : "Failed to load saved action sets.");
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadJobs();
    loadDatasets();
  }, []);

  useEffect(() => {
    const hasActive = jobs?.some((j) => j.status === "queued" || j.status === "processing");
    if (!hasActive && !autoOpenJobId) return;
    const interval = setInterval(loadJobs, 4000);
    return () => clearInterval(interval);
  }, [jobs, autoOpenJobId]);

  // The job this page itself just started: open its review the instant it
  // finishes, instead of making the user come back and click "Review".
  useEffect(() => {
    if (!autoOpenJobId || reviewMode) return;
    const job = jobs?.find((j) => j.job_id === autoOpenJobId);
    if (!job) return;
    if (job.status === "done") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoOpenJobId(null);
      openReview(job);
    } else if (job.status === "failed" || job.status === "cancelled") {
      setAutoOpenJobId(null);
    }
  }, [jobs, autoOpenJobId, reviewMode]);

  async function handleStartDiscovery() {
    setUploadError(null);
    if (!videoFile) {
      setUploadError("Choose a video file first.");
      return;
    }
    setUploading(true);
    setUploadProgress(0);
    try {
      const result = await uploadToGCS(videoFile, "video-uploads", setUploadProgress);
      const created = await api.actions.discover({
        storage_path: result.storage_path,
        original_filename: videoFile.name,
        fps,
        min_cluster_size: minClusterSize,
      });
      setVideoFile(null);
      setAutoOpenJobId(created.job_id);
      await loadJobs();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Failed to start discovery.");
    } finally {
      setUploading(false);
    }
  }

  async function handleCancelOrDeleteJob(jobId: string) {
    try {
      await api.actions.cancelOrDeleteDiscoveryJob(jobId);
      if (autoOpenJobId === jobId) setAutoOpenJobId(null);
      await loadJobs();
    } catch (err) {
      setJobsError(err instanceof Error ? err.message : "Failed to cancel/delete job.");
    }
  }

  async function openReview(job: ActionDiscoveryJobOut) {
    setSaveError(null);
    setReviewMode("discover");
    setReviewSourceId(job.job_id);
    setReviewSourceLabel(job.original_filename);
    setDatasetName(job.original_filename.replace(/\.[^.]+$/, ""));
    setSelectedForMerge(new Set());
    const clusters = job.clusters ?? [];
    // Cards render immediately, empty — each one's images then stream in as
    // their own fetch resolves, instead of the whole page waiting on every
    // single image before showing anything.
    const drafts: ActionClassDraft[] = clusters.map((cluster) => ({
      id: newId(),
      name: cluster.name,
      images: [],
      pendingImages: cluster.frame_count,
    }));
    setClasses(drafts);
    try {
      await Promise.all(
        clusters.map((cluster, i) => {
          const draftId = drafts[i].id;
          const frameIds = Array.from({ length: cluster.frame_count }, (_, idx) => String(idx));
          return Promise.all(
            frameIds.map(async (frameId) => {
              const previewUrl = await api.actions.frameUrl(job.job_id, cluster.id, frameId);
              const image: ActionImageDraft = { key: `${cluster.id}:${frameId}`, source: "discover", clusterId: cluster.id, frameId, previewUrl };
              setClasses((prev) =>
                prev.map((c) =>
                  c.id === draftId
                    ? { ...c, images: [...c.images, image], pendingImages: Math.max(0, (c.pendingImages ?? 1) - 1) }
                    : c
                )
              );
            })
          );
        })
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to load discovered actions.");
    }
  }

  async function openEditDataset(dataset: ActionDatasetOut) {
    setSaveError(null);
    setReviewMode("edit");
    setReviewSourceId(dataset.dataset_id);
    setReviewSourceLabel(dataset.name);
    setDatasetName(dataset.name);
    setSelectedForMerge(new Set());
    // Same progressive fill as openReview - cards appear immediately, each
    // image pops in as its own fetch resolves.
    const drafts: ActionClassDraft[] = dataset.classes.map((cls) => ({
      id: newId(),
      name: cls.name,
      images: [],
      pendingImages: cls.image_count,
    }));
    setClasses(drafts);
    try {
      await Promise.all(
        dataset.classes.map((cls, classIndex) => {
          const draftId = drafts[classIndex].id;
          const imageIndices = Array.from({ length: cls.image_count }, (_, i) => i);
          return Promise.all(
            imageIndices.map(async (imageIndex) => {
              const previewUrl = await api.actions.datasetImageUrl(dataset.dataset_id, classIndex, imageIndex);
              const image: ActionImageDraft = {
                key: `ds:${classIndex}:${imageIndex}`,
                source: "dataset",
                datasetClassIndex: classIndex,
                datasetImageIndex: imageIndex,
                previewUrl,
              };
              setClasses((prev) =>
                prev.map((c) =>
                  c.id === draftId
                    ? { ...c, images: [...c.images, image], pendingImages: Math.max(0, (c.pendingImages ?? 1) - 1) }
                    : c
                )
              );
            })
          );
        })
      );
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to load this action set's actions.");
    }
  }

  function exitReview() {
    revokePreviewUrls(classes);
    setReviewMode(null);
    setReviewSourceId(null);
    setReviewSourceLabel("");
    setClasses([]);
    setSelectedForMerge(new Set());
    setDatasetName("");
    setSaveError(null);
  }

  function toggleMergeSelect(classId: string) {
    setSelectedForMerge((prev) => {
      const next = new Set(prev);
      if (next.has(classId)) next.delete(classId);
      else next.add(classId);
      return next;
    });
  }

  function mergeSelected() {
    if (selectedForMerge.size < 2) return;
    setClasses((prev) => {
      let merged: ActionClassDraft | null = null;
      const result: ActionClassDraft[] = [];
      for (const cls of prev) {
        if (selectedForMerge.has(cls.id)) {
          if (!merged) {
            merged = { id: cls.id, name: cls.name, images: [...cls.images] };
            result.push(merged);
          } else {
            merged.images = [...merged.images, ...cls.images];
          }
        } else {
          result.push(cls);
        }
      }
      return result;
    });
    setSelectedForMerge(new Set());
  }

  function renameClass(id: string, name: string) {
    setClasses((prev) => prev.map((c) => (c.id === id ? { ...c, name } : c)));
  }

  function addClass() {
    setClasses((prev) => [...prev, { id: newId(), name: `Action ${prev.length + 1}`, images: [] }]);
  }

  function removeClass(id: string) {
    setClasses((prev) => {
      const target = prev.find((c) => c.id === id);
      target?.images.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      return prev.filter((c) => c.id !== id);
    });
    setSelectedForMerge((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // Opens the lightbox on the clicked image, scoped to the REST of that
  // same action's images too — so ‹ › inside the lightbox steps through
  // just that action's grid, not the whole page's worth of thumbnails.
  function openActionLightbox(images: ActionImageDraft[], clickedKey: string) {
    const index = images.findIndex((img) => img.key === clickedKey);
    if (index === -1) return;
    setLightbox({ images: images.map((img) => img.previewUrl), index });
  }

  function removeImage(classId: string, key: string) {
    setClasses((prev) =>
      prev.map((c) => {
        if (c.id !== classId) return c;
        const target = c.images.find((img) => img.key === key);
        if (target) URL.revokeObjectURL(target.previewUrl);
        return { ...c, images: c.images.filter((img) => img.key !== key) };
      })
    );
  }

  // Moves one image from its current action into a different one, in place
  // (no re-upload, no URL churn — same ActionImageDraft object just moves
  // arrays). No-op if dropped back onto its own action.
  function moveImage(imageKey: string, fromClassId: string, toClassId: string) {
    if (fromClassId === toClassId) return;
    setClasses((prev) => {
      const source = prev.find((c) => c.id === fromClassId);
      const image = source?.images.find((img) => img.key === imageKey);
      if (!image) return prev;
      return prev.map((c) => {
        if (c.id === fromClassId) return { ...c, images: c.images.filter((img) => img.key !== imageKey) };
        if (c.id === toClassId) return { ...c, images: [...c.images, image] };
        return c;
      });
    });
  }

  async function addImagesToClass(classId: string, files: File[]) {
    if (files.length === 0) return;
    setUploadingClassId(classId);
    setSaveError(null);
    try {
      for (const file of files) {
        const result = await uploadToGCS(file, "training-uploads");
        const previewUrl = URL.createObjectURL(file);
        setClasses((prev) =>
          prev.map((c) =>
            c.id === classId
              ? {
                  ...c,
                  images: [...c.images, { key: `upload:${result.storage_path}`, source: "upload", storagePath: result.storage_path, previewUrl }],
                }
              : c
          )
        );
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to upload image.");
    } finally {
      setUploadingClassId(null);
    }
  }

  async function handleSaveDataset() {
    setSaveError(null);
    if (!reviewMode || !reviewSourceId) return;
    const name = datasetName.trim();
    if (!name) {
      setSaveError("Give this action set a name.");
      return;
    }
    const usable = classes.map((c) => ({ ...c, name: c.name.trim() })).filter((c) => c.name && c.images.length > 0);
    if (usable.length < 1) {
      setSaveError("Add at least one action with at least one image.");
      return;
    }
    setSaving(true);
    try {
      if (reviewMode === "discover") {
        await api.actions.saveDataset(reviewSourceId, {
          name,
          classes: usable.map((c) => ({
            name: c.name,
            images: c.images.map((img) =>
              img.storagePath ? { storage_path: img.storagePath } : { cluster_id: img.clusterId, frame_id: img.frameId }
            ),
          })),
        });
      } else {
        await api.actions.updateDataset(reviewSourceId, {
          name,
          classes: usable.map((c) => ({
            name: c.name,
            images: c.images.map((img) =>
              img.storagePath
                ? { storage_path: img.storagePath }
                : { class_index: img.datasetClassIndex, image_index: img.datasetImageIndex }
            ),
          })),
        });
      }
      revokePreviewUrls(classes);
      setReviewMode(null);
      setReviewSourceId(null);
      setReviewSourceLabel("");
      setClasses([]);
      setDatasetName("");
      setDatasetPreviews({});
      await loadJobs();
      await loadDatasets();
      setTab("saved");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save action set.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleExpandDataset(dataset: ActionDatasetOut) {
    if (expandedDatasetId === dataset.dataset_id) {
      setExpandedDatasetId(null);
      return;
    }
    setExpandedDatasetId(dataset.dataset_id);
    if (datasetPreviews[dataset.dataset_id]) return;
    // null = still loading — the grid renders instantly with that many
    // skeleton slots, then each thumbnail pops in as its own fetch resolves
    // instead of the whole grid waiting on the slowest image.
    const counts = dataset.classes.map((cls) => Math.min(cls.image_count, 8));
    setDatasetPreviews((prev) => ({
      ...prev,
      [dataset.dataset_id]: counts.map((count) => Array.from({ length: count }, () => null)),
    }));
    try {
      await Promise.all(
        dataset.classes.map((cls, classIndex) => {
          const count = counts[classIndex];
          return Promise.all(
            Array.from({ length: count }, (_, imageIndex) =>
              api.actions.datasetImageUrl(dataset.dataset_id, classIndex, imageIndex).then((url) => {
                setDatasetPreviews((prev) => {
                  const current = prev[dataset.dataset_id];
                  if (!current) return prev;
                  const nextRow = [...current[classIndex]];
                  nextRow[imageIndex] = url;
                  const nextRows = [...current];
                  nextRows[classIndex] = nextRow;
                  return { ...prev, [dataset.dataset_id]: nextRows };
                });
              })
            )
          );
        })
      );
    } catch {
      // Thumbnails are a nicety — the dataset's name/action/count info above
      // still renders fine even if some previews fail to load.
    }
  }

  async function confirmDeleteDataset() {
    if (!deleteDatasetTarget) return;
    setDeleteDatasetBusy(true);
    try {
      await api.actions.deleteDataset(deleteDatasetTarget.dataset_id);
      setDeleteDatasetTarget(null);
      await loadDatasets();
    } catch (err) {
      setDatasetsError(err instanceof Error ? err.message : "Failed to delete action set.");
    } finally {
      setDeleteDatasetBusy(false);
    }
  }

  const activeJobCount = jobs?.filter((j) => j.status === "queued" || j.status === "processing").length ?? 0;

  return (
    <AppShell section="create-actions" crumb="Create actions">
      <Container className="py-10">
        <PageHeader
          eyebrow="Create actions"
          subtitle={PAGE_SUBTITLES["create-actions"]}
          title="Auto-discover actions from a video"
          helpAnchor={HELP_ANCHORS.createActions}
        />

        {!reviewMode && (
          <Tabs
            tabs={[
              {
                id: "discover",
                label: `Discover${activeJobCount > 0 ? ` (${activeJobCount} active)` : ""}`,
                tooltip: TAB_TOOLTIPS.createActions.discover,
              },
              { id: "saved", label: "Saved action sets", tooltip: TAB_TOOLTIPS.createActions.saved },
            ]}
            active={tab}
            onChange={setTab}
          />
        )}

        {reviewMode ? (
          <div className="relative space-y-6">
            <div>
              <Button variant="ghost" size="sm" onClick={exitReview} disabled={saving}>
                ‹ Back
              </Button>
              <p className="mt-1 text-sm text-neutral-500">
                {reviewMode === "discover" ? "Reviewing actions from" : "Editing"}{" "}
                <span className="font-medium text-text">{reviewSourceLabel}</span>
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-[1fr_260px]">
                <div className="min-w-0 space-y-4">
                  <Card>
                    <CardHeader title="Action set name" />
                    <Input value={datasetName} onChange={(e) => setDatasetName(e.target.value)} placeholder="e.g. math-game-demo-actions" disabled={saving} />
                  </Card>

                  {saveError && <Alert tone="danger">{saveError}</Alert>}

                  {classes.map((cls, i) => (
                    <Card
                      key={cls.id}
                      className={`animate-fade-in-up transition-shadow ${
                        dragOverClassId === cls.id && draggedImage?.classId !== cls.id
                          ? "ring-2 ring-primary ring-offset-2 ring-offset-surface"
                          : ""
                      }`}
                      style={stagger(i, 30)}
                      onDragOver={(e) => {
                        if (!draggedImage) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dragOverClassId !== cls.id) setDragOverClassId(cls.id);
                      }}
                      onDragLeave={() => setDragOverClassId((prev) => (prev === cls.id ? null : prev))}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (draggedImage) moveImage(draggedImage.key, draggedImage.classId, cls.id);
                        setDraggedImage(null);
                        setDragOverClassId(null);
                      }}
                    >
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-1 items-center gap-3">
                          <input
                            type="checkbox"
                            checked={selectedForMerge.has(cls.id)}
                            onChange={() => toggleMergeSelect(cls.id)}
                            disabled={saving}
                            aria-label={`Select "${cls.name}" for merging`}
                            className="h-4 w-4 shrink-0 accent-primary"
                          />
                          <Input
                            value={cls.name}
                            onChange={(e) => renameClass(cls.id, e.target.value)}
                            disabled={saving}
                            className="max-w-xs"
                          />
                          <Badge tone="neutral">{cls.images.length} image{cls.images.length === 1 ? "" : "s"}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          <label className={`cursor-pointer ${uploadingClassId === cls.id || saving ? "pointer-events-none opacity-60" : ""}`}>
                            <span className="inline-flex h-9 items-center rounded-lg border border-neutral-300 px-3 text-sm font-medium text-text hover:bg-neutral-100">
                              {uploadingClassId === cls.id ? <Spinner size="sm" /> : "+ Add images"}
                            </span>
                            <input
                              type="file"
                              accept="image/*"
                              multiple
                              className="hidden"
                              disabled={uploadingClassId === cls.id || saving}
                              onChange={(e) => {
                                addImagesToClass(cls.id, Array.from(e.target.files ?? []));
                                e.target.value = "";
                              }}
                            />
                          </label>
                          <Button variant="danger" size="sm" onClick={() => removeClass(cls.id)} disabled={saving}>
                            Delete
                          </Button>
                        </div>
                      </div>

                      {cls.images.length === 0 && !cls.pendingImages ? (
                        <p className="text-sm text-neutral-500">
                          {dragOverClassId === cls.id && draggedImage ? "Drop to move image here" : "No images in this action yet."}
                        </p>
                      ) : (
                        <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                          {cls.images.map((img) => (
                            <div
                              key={img.key}
                              draggable={!saving}
                              onDragStart={(e) => {
                                setDraggedImage({ classId: cls.id, key: img.key });
                                e.dataTransfer.effectAllowed = "move";
                                // Some browsers need real drag data set to allow the drop.
                                e.dataTransfer.setData("text/plain", img.key);
                              }}
                              onDragEnd={() => {
                                setDraggedImage(null);
                                setDragOverClassId(null);
                              }}
                              className={`group relative aspect-square cursor-grab overflow-hidden rounded-lg border border-neutral-200 active:cursor-grabbing animate-scale-in ${
                                draggedImage?.key === img.key ? "opacity-40" : ""
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => openActionLightbox(cls.images, img.key)}
                                className="block h-full w-full cursor-zoom-in"
                                aria-label="View full size"
                              >
                                {/* Local blob: object URLs — next/image can't optimize these, plain <img> is correct here. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={img.previewUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeImage(cls.id, img.key)}
                                aria-label="Remove image"
                                disabled={saving}
                                className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs text-white group-hover:flex disabled:pointer-events-none"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          {Array.from({ length: cls.pendingImages ?? 0 }).map((_, i) => (
                            <Skeleton key={`pending-${cls.id}-${i}`} className="aspect-square rounded-lg" />
                          ))}
                        </div>
                      )}
                    </Card>
                  ))}

                  {classes.length === 0 && (
                    <EmptyState title="No actions to review" />
                  )}
                </div>

                {/* Fixed alongside the action list so merging/adding never
                    requires scrolling back up — sticks within the viewport
                    on desktop, sits above the list on narrower screens. */}
                {/* top-20 (not top-6) deliberately clears the AppShell's own
                    sticky Topbar (~45px tall) with visible room to spare —
                    top-6 alone left this panel's top edge touching the
                    breadcrumb bar as the page scrolled. */}
                <aside className="space-y-3 lg:sticky lg:top-20 lg:h-fit">
                  <Card>
                    <p className="mb-3 text-sm font-semibold text-text">Manage actions</p>
                    <div className="space-y-2">
                      <Tooltip label={BUTTON_TOOLTIPS.addAction} wrapperClassName="block">
                        <Button variant="outline" className="w-full" onClick={addClass} disabled={saving}>
                          + Add new action
                        </Button>
                      </Tooltip>
                      <Tooltip label={BUTTON_TOOLTIPS.merge} wrapperClassName="block">
                        <Button
                          variant="outline"
                          className="w-full"
                          onClick={mergeSelected}
                          disabled={selectedForMerge.size < 2 || saving}
                        >
                          Merge selected {selectedForMerge.size > 1 ? `(${selectedForMerge.size})` : ""}
                        </Button>
                      </Tooltip>
                    </div>
                  </Card>

                  <Card>
                    <Button size="lg" className="w-full" onClick={handleSaveDataset} loading={saving} disabled={classes.length === 0}>
                      Save action set
                    </Button>
                    <Button variant="outline" className="mt-2 w-full" onClick={exitReview} disabled={saving}>
                      Cancel
                    </Button>
                  </Card>
                </aside>
              </div>
          </div>
        ) : (
          <>
            {tab === "discover" && (
              <div className="space-y-6">
                <Card className="max-w-3xl">
                  <CardHeader title="Upload a demo video" />
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="sm:col-span-3">
                      <Label htmlFor="action-video-file" tooltip={FIELD_TOOLTIPS.createActions.video}>Screen recording</Label>
                      <input
                        id="action-video-file"
                        type="file"
                        accept="video/*"
                        disabled={uploading}
                        onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)}
                        className="block w-full text-sm text-neutral-600 file:mr-4 file:h-11 file:rounded-lg file:border-0 file:bg-primary-tint file:px-4 file:text-sm file:font-medium file:text-primary-hover hover:file:bg-primary/20"
                      />
                      {videoFile && <p className="mt-1.5 text-sm text-neutral-500">{videoFile.name}</p>}
                    </div>
                    <div>
                      <Label htmlFor="action-fps" tooltip={FIELD_TOOLTIPS.createActions.fps}>Sampling FPS</Label>
                      <Input
                        id="action-fps"
                        type="number"
                        min={1}
                        max={30}
                        value={fps}
                        onChange={(e) => setFps(Number(e.target.value) || 1)}
                        disabled={uploading}
                      />
                    </div>
                    <div>
                      <Label htmlFor="action-min-cluster" tooltip={FIELD_TOOLTIPS.createActions.minCluster}>Minimum cluster size</Label>
                      <Input
                        id="action-min-cluster"
                        type="number"
                        min={2}
                        max={50}
                        value={minClusterSize}
                        onChange={(e) => setMinClusterSize(Number(e.target.value) || 2)}
                        disabled={uploading}
                      />
                    </div>
                    <div className="flex items-end">
                      <Button className="w-full" onClick={handleStartDiscovery} loading={uploading} disabled={!videoFile}>
                        Upload &amp; discover
                      </Button>
                    </div>
                  </div>

                  {uploading && (
                    <div className="mt-4">
                      <div className="mb-1 flex items-center justify-between text-sm text-neutral-500">
                        <span>Uploading video…</span>
                        <span className="font-mono text-xs text-neutral-400">{Math.round(uploadProgress * 100)}%</span>
                      </div>
                      <ProgressBar fraction={uploadProgress} />
                    </div>
                  )}
                  {uploadError && (
                    <Alert tone="danger" className="mt-4">
                      {uploadError}
                    </Alert>
                  )}
                </Card>

                <div>
                  <h2 className="mb-4 text-lg font-semibold text-text">Discovery jobs</h2>
                  {jobsError && (
                    <Alert tone="danger" className="mb-4">
                      {jobsError}
                    </Alert>
                  )}
                  {jobs === null ? (
                    <div className="space-y-3">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Card key={i} className="animate-fade-in-up p-4" style={stagger(i, 60)}>
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <Skeleton className="h-4 w-1/3" />
                              <Skeleton className="mt-2 h-3 w-1/2" />
                            </div>
                            <Skeleton className="h-6 w-20 shrink-0" />
                          </div>
                        </Card>
                      ))}
                    </div>
                  ) : jobs.length === 0 ? (
                    <EmptyState title="No discovery jobs yet" />
                  ) : (
                    <div className="space-y-3">
                      {jobs.map((job, i) => (
                        <Card key={job.job_id} className="animate-fade-in-up p-4" style={stagger(i, 35)}>
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium text-text">{job.original_filename}</p>
                              <p className="text-sm text-neutral-500">
                                {formatDate(job.created_at)}
                                {job.clusters ? ` · ${job.clusters.length} actions found` : ""}
                              </p>
                              {job.status === "processing" && job.progress && (
                                <div className="mt-2 max-w-xs">
                                  <div className="mb-1 flex items-center gap-2 text-sm text-neutral-500">
                                    <Spinner size="sm" />
                                    <span className="truncate">{progressLabel(job.progress)}</span>
                                    <span className="ml-auto shrink-0 font-mono text-xs text-neutral-400">
                                      {Math.round(progressFraction(job.progress.stage) * 100)}%
                                    </span>
                                  </div>
                                  <ProgressBar fraction={progressFraction(job.progress.stage)} />
                                  {autoOpenJobId === job.job_id && (
                                    <p className="mt-1 text-xs text-neutral-400">Opens automatically when done</p>
                                  )}
                                </div>
                              )}
                              {job.status === "failed" && job.error && (
                                <p className="mt-1 text-sm text-danger">{job.error}</p>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <StatusBadge status={job.status} />
                              {job.status === "done" && (
                                <Button size="sm" onClick={() => openReview(job)}>
                                  Review
                                </Button>
                              )}
                              {(job.status === "queued" || job.status === "done" || job.status === "failed") && (
                                <Button size="sm" variant="ghost" onClick={() => handleCancelOrDeleteJob(job.job_id)}>
                                  {job.status === "queued" ? "Cancel" : "Delete"}
                                </Button>
                              )}
                            </div>
                          </div>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === "saved" && (
              <div>
                {datasetsError && (
                  <Alert tone="danger" className="mb-4">
                    {datasetsError}
                  </Alert>
                )}
                {datasets === null ? (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <div key={i} className="animate-fade-in-up" style={stagger(i)}>
                        <SkeletonCard />
                      </div>
                    ))}
                  </div>
                ) : datasets.length === 0 ? (
                  <EmptyState title="No saved action sets yet" />
                ) : (
                  <div className="space-y-3">
                    {datasets.map((ds, i) => (
                      <Card key={ds.dataset_id} className="animate-fade-in-up p-4" style={stagger(i, 40)}>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-text">{ds.name}</p>
                            <p className="text-sm text-neutral-500">
                              {ds.classes.length} action{ds.classes.length === 1 ? "" : "s"} · {ds.total_images} images
                              {ds.source_video_filename ? ` · from ${ds.source_video_filename}` : ""} · {formatDate(ds.created_at)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" onClick={() => toggleExpandDataset(ds)}>
                              {expandedDatasetId === ds.dataset_id ? "Hide" : "View"}
                            </Button>
                            <Button size="sm" onClick={() => openEditDataset(ds)}>
                              Edit
                            </Button>
                            <Button size="sm" variant="danger" onClick={() => setDeleteDatasetTarget(ds)}>
                              Delete
                            </Button>
                          </div>
                        </div>

                        {expandedDatasetId === ds.dataset_id && (
                          <div className="mt-4 space-y-4 border-t border-neutral-100 pt-4">
                            {ds.classes.map((cls, classIndex) => {
                              const row = datasetPreviews[ds.dataset_id]?.[classIndex] ?? [];
                              const resolvedUrls = row.filter((u): u is string => u !== null);
                              return (
                                <div key={cls.name}>
                                  <p className="mb-2 text-sm font-medium text-text">
                                    {cls.name} <span className="text-neutral-500">({cls.image_count})</span>
                                  </p>
                                  <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
                                    {row.map((url, imgIdx) =>
                                      url ? (
                                        <button
                                          key={imgIdx}
                                          type="button"
                                          onClick={() => setLightbox({ images: resolvedUrls, index: resolvedUrls.indexOf(url) })}
                                          className="aspect-square cursor-zoom-in overflow-hidden rounded-lg border border-neutral-200 animate-scale-in"
                                          aria-label="View full size"
                                        >
                                          {/* eslint-disable-next-line @next/next/no-img-element */}
                                          <img src={url} alt="" className="h-full w-full object-cover" />
                                        </button>
                                      ) : (
                                        <Skeleton key={imgIdx} className="aspect-square rounded-lg" />
                                      )
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </Container>

      {saving && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center bg-black/40 backdrop-blur-sm" role="status" aria-live="polite">
          <div className="animate-fade-in-up flex w-72 flex-col items-center gap-4 rounded-2xl border border-neutral-200 bg-surface px-8 py-7 text-center shadow-2xl">
            <Spinner size="lg" />
            <p className="text-sm font-semibold text-text">Saving your action set…</p>
            <div className="w-full">
              <IndeterminateProgressBar />
            </div>
          </div>
        </div>
      )}

      <ImageLightbox
        images={lightbox?.images ?? []}
        index={lightbox?.index ?? 0}
        onIndexChange={(index) => setLightbox((prev) => (prev ? { ...prev, index } : prev))}
        onClose={() => setLightbox(null)}
      />

      <ConfirmDialog
        open={deleteDatasetTarget !== null}
        title="Delete this action set?"
        description={
          deleteDatasetTarget && (
            <>
              This permanently deletes <span className="font-medium text-text">{deleteDatasetTarget.name}</span> and all{" "}
              {deleteDatasetTarget.total_images} of its images. This can&apos;t be undone.
            </>
          )
        }
        confirmLabel="Delete action set"
        busy={deleteDatasetBusy}
        onConfirm={confirmDeleteDataset}
        onCancel={() => setDeleteDatasetTarget(null)}
      />
    </AppShell>
  );
}

export default function CreateActionsPage() {
  return (
    <ProtectedRoute>
      <CreateActionsContent />
    </ProtectedRoute>
  );
}
