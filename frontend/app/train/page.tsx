"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { api } from "@/lib/api";
import { uploadToGCS } from "@/lib/gcs";
import type { ActionDatasetOut, TrainingImageRef, TrainJobOut, TrainProgress } from "@/lib/types";
import { ocrExcludedNote } from "@/lib/trainingMetrics";
import { Container, PageHeader } from "@/components/ui/Section";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Input, Label, HelpText, Select } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { ImageDropzone } from "@/components/train/ImageDropzone";
import { MetricsReport } from "@/components/train/MetricsReport";
import { Skeleton } from "@/components/ui/Skeleton";
import { ImageLightbox } from "@/components/ui/ImageLightbox";

function stagger(index: number, stepMs = 45): CSSProperties {
  return { "--stagger": `${index * stepMs}ms` } as CSSProperties;
}

interface ClassDraft {
  id: string;
  name: string;
  files: File[];
}

// One image inside an imported action — `ref` is what actually gets
// submitted to POST /train (a fresh, disposable training-uploads/ copy made
// by copy-for-training); `previewUrl` is just for display — fetched from
// the SOURCE dataset's own permanent storage (untouched by the copy) for
// already-imported images, or a local blob: URL for images added by hand
// afterward.
interface ImportedImageDraft {
  key: string;
  ref: TrainingImageRef;
  previewUrl: string;
}

interface ImportedClassDraft {
  name: string;
  images: ImportedImageDraft[];
}

let idCounter = 0;
function newId() {
  idCounter += 1;
  return `class-${idCounter}-${Date.now()}`;
}

function revokeImportedPreviews(classes: ImportedClassDraft[]) {
  for (const cls of classes) {
    for (const img of cls.images) URL.revokeObjectURL(img.previewUrl);
  }
}

// True only for the untouched, freshly-mounted "Action 1"/"Action 2"
// placeholder pair — never true once the user has renamed either one or
// added a single file. Used to clear that starter pair out of the way the
// first time a dataset is imported, since it's just visual clutter once
// there are real imported actions to train from; the user can still add a
// hand-built action afterward via "+ Add another action" if they want one.
function isPristineDefaultClasses(list: ClassDraft[]): boolean {
  return (
    list.length === 2 &&
    list[0].name === "Action 1" &&
    list[0].files.length === 0 &&
    list[1].name === "Action 2" &&
    list[1].files.length === 0
  );
}

type Tab = "train" | "jobs";

const ACTIVE_TRAIN_STATUSES = new Set(["queued", "processing"]);

// A "queued" job that's been sitting for longer than this is almost
// certainly stuck (worker crashed/never started) rather than just waiting
// its turn — offer Retry for it instead of leaving the user stranded.
// "processing" gets a much longer leash since real training legitimately
// takes minutes. Mirrors the backend's _is_retryable() in routers/train.py —
// keep the two in sync.
const STUCK_QUEUED_MS = 2 * 60 * 1000;
const STUCK_PROCESSING_MS = 30 * 60 * 1000;

// Advanced (optional) training options — mirrors the defaults in
// backend/app/schemas.py::TrainRequest. Collapsed behind a toggle since
// most training runs never need to touch these.
const DEFAULT_EPOCHS = 20;
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_LEARNING_RATE = 0.001;
const DEFAULT_SPLIT = { train: 70, val: 15, test: 15 }; // percentages, converted to fractions on submit

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function isRetryable(job: TrainJobOut): boolean {
  if (job.status === "failed") return true;
  if (job.status === "queued" && job.created_at) {
    return Date.now() - new Date(job.created_at).getTime() > STUCK_QUEUED_MS;
  }
  if (job.status === "processing" && job.started_at) {
    return Date.now() - new Date(job.started_at).getTime() > STUCK_PROCESSING_MS;
  }
  return false;
}

const STAGE_LABELS: Record<string, string> = {
  starting: "Starting",
  downloading: "Downloading images",
  training_cnn: "Training model",
  evaluating_cnn: "Evaluating on test set",
  extracting_text: "Reading on-screen text (OCR)",
  tuning_fusion: "Tuning text/image fusion",
  saving_model: "Saving model",
};

function progressLabel(progress: TrainProgress | null): string | null {
  if (!progress) return null;
  const base = STAGE_LABELS[progress.stage] || progress.stage;
  if (progress.stage === "training_cnn" && progress.epoch != null && progress.epochs != null) {
    const acc = progress.accuracy != null ? ` · acc ${(progress.accuracy * 100).toFixed(0)}%` : "";
    return `${base} — epoch ${progress.epoch}/${progress.epochs}${acc}`;
  }
  return progress.detail ? `${base} — ${progress.detail}` : `${base}…`;
}

function TrainContent() {
  const [tab, setTab] = useState<Tab>("train");

  const [classes, setClasses] = useState<ClassDraft[]>([
    { id: newId(), name: "Action 1", files: [] },
    { id: newId(), name: "Action 2", files: [] },
  ]);
  const [modelName, setModelName] = useState("");
  const [epochs, setEpochs] = useState(DEFAULT_EPOCHS);
  const [batchSize, setBatchSize] = useState(DEFAULT_BATCH_SIZE);
  const [learningRate, setLearningRate] = useState(DEFAULT_LEARNING_RATE);
  const [splitTrain, setSplitTrain] = useState(DEFAULT_SPLIT.train);
  const [splitVal, setSplitVal] = useState(DEFAULT_SPLIT.val);
  const [splitTest, setSplitTest] = useState(DEFAULT_SPLIT.test);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const splitSum = splitTrain + splitVal + splitTest;

  const [phase, setPhase] = useState<"idle" | "uploading" | "training" | "done" | "error">("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadLabel, setUploadLabel] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [trainJob, setTrainJob] = useState<TrainJobOut | null>(null);

  // Job history — lets a failed job (e.g. a local TensorFlow crash) be
  // retried without re-uploading images, instead of only ever seeing the
  // single most-recently-submitted job.
  const [trainingJobs, setTrainingJobs] = useState<TrainJobOut[] | null>(null);
  const [jobsListError, setJobsListError] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // Import from a saved "Create actions" dataset — kept as its own list,
  // visually distinct from the hand-built classes above, rather than
  // retrofitted into ClassDraft/ImageDropzone. Each entry already carries
  // real TrainingImageRef storage paths (fresh, disposable copies made by
  // POST /actions/datasets/{id}/copy-for-training) — there's nothing left to
  // upload for those; preview thumbnails are fetched separately, straight
  // from the SOURCE dataset (untouched by the copy).
  const [datasets, setDatasets] = useState<ActionDatasetOut[] | null>(null);
  const [selectedDatasetId, setSelectedDatasetId] = useState("");
  const [selectedImportClasses, setSelectedImportClasses] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importedClasses, setImportedClasses] = useState<ImportedClassDraft[]>([]);
  const [importUploadingClass, setImportUploadingClass] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadDatasets() {
    try {
      setDatasets(await api.actions.listDatasets());
    } catch {
      setDatasets([]);
    }
  }

  async function loadTrainingJobs() {
    setJobsListError(null);
    try {
      setTrainingJobs(await api.train.list());
    } catch (err) {
      setJobsListError(err instanceof Error ? err.message : "Failed to load training job history.");
    }
  }

  /** Landed here via the model detail page's "Retrain with new settings"
   * button (?retrainModel={id}) — pre-fill the class names and model name
   * from that model so the user only has to re-add example images (the
   * originals were deleted from Cloud Storage once training succeeded) and
   * adjust Advanced options before submitting. Reading the query param via
   * window.location instead of useSearchParams() avoids Next's
   * Suspense-boundary requirement for a value we only ever need once, on
   * mount. */
  async function prefillFromRetrainQuery() {
    const retrainModelId = new URLSearchParams(window.location.search).get("retrainModel");
    if (!retrainModelId) return;
    try {
      const model = await api.models.get(retrainModelId);
      setModelName(model.name);
      setClasses(model.labels.map((label) => ({ id: newId(), name: label, files: [] })));
      setShowAdvanced(true);
      setTab("train");
    } catch {
      // Model may be gone or inaccessible — worst case the form just starts blank.
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadTrainingJobs();
    loadDatasets();
    prefillFromRetrainQuery();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Selecting a dataset in the import picker defaults to every one of its
  // classes checked — most of the time you want the whole thing, not a
  // hand-picked subset.
  useEffect(() => {
    const dataset = datasets?.find((d) => d.dataset_id === selectedDatasetId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedImportClasses(new Set(dataset ? dataset.classes.map((c) => c.name) : []));
  }, [selectedDatasetId, datasets]);

  useEffect(() => {
    const hasActive = trainingJobs?.some((j) => ACTIVE_TRAIN_STATUSES.has(j.status));
    if (!hasActive) return;
    const interval = setInterval(loadTrainingJobs, 4000);
    return () => clearInterval(interval);
  }, [trainingJobs]);

  function addClass() {
    setClasses((c) => [...c, { id: newId(), name: `Action ${c.length + 1}`, files: [] }]);
  }

  function removeClass(id: string) {
    // The "at least 2 actions to train" floor is shared across BOTH
    // hand-built classes and imported ones (see handleSubmit's own
    // `usable.length + importedClasses.length < 2` check) — a class here
    // is only truly the last one standing if there are zero imported
    // actions to fall back on too.
    setClasses((c) => (c.length - 1 + importedClasses.length < 2 ? c : c.filter((cl) => cl.id !== id)));
  }

  function renameClass(id: string, name: string) {
    setClasses((c) => c.map((cl) => (cl.id === id ? { ...cl, name } : cl)));
  }

  function setClassFiles(id: string, files: File[]) {
    setClasses((c) => c.map((cl) => (cl.id === id ? { ...cl, files } : cl)));
  }

  function toggleImportClass(name: string) {
    setSelectedImportClasses((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleImport() {
    setImportError(null);
    const dataset = datasets?.find((d) => d.dataset_id === selectedDatasetId);
    if (!dataset) {
      setImportError("Pick a saved dataset first.");
      return;
    }
    const classNames = Array.from(selectedImportClasses);
    if (classNames.length === 0) {
      setImportError("Select at least one action to import.");
      return;
    }
    setImporting(true);
    try {
      // class_names omitted entirely (not just an empty array) copies every
      // class — only pass it when the user deliberately narrowed the
      // selection below the dataset's full class list.
      const wantsAll = classNames.length === dataset.classes.length;
      const result = await api.actions.copyForTraining(dataset.dataset_id, wantsAll ? undefined : classNames);

      // Preview thumbnails come from the SOURCE dataset (its own permanent
      // storage, untouched by the copy above) — same class_index/image_index
      // proxy endpoint the create-actions page's "View" uses. Best-effort:
      // if a class's name can't be matched back to the dataset (shouldn't
      // happen) or a fetch fails, that entry just shows no thumbnails.
      const newEntries: ImportedClassDraft[] = [];
      for (const [name, refs] of Object.entries(result)) {
        const classIndex = dataset.classes.findIndex((c) => c.name === name);
        let previewUrls: string[] = [];
        if (classIndex !== -1) {
          try {
            previewUrls = await Promise.all(
              refs.map((_, imageIndex) => api.actions.datasetImageUrl(dataset.dataset_id, classIndex, imageIndex))
            );
          } catch {
            previewUrls = [];
          }
        }
        newEntries.push({
          name,
          images: refs.map((ref, i) => ({ key: ref.storage_path, ref, previewUrl: previewUrls[i] ?? "" })),
        });
      }

      setImportedClasses((prev) => {
        const byName = new Map(prev.map((c) => [c.name, c]));
        for (const entry of newEntries) {
          const existing = byName.get(entry.name);
          byName.set(entry.name, existing ? { name: entry.name, images: [...existing.images, ...entry.images] } : entry);
        }
        return Array.from(byName.values());
      });
      // First import clears the untouched "Action 1"/"Action 2" starter
      // pair out of the way — it's just clutter once there are real
      // imported actions, and never fires again once the user has actually
      // used that section (renamed or added a file to either one).
      setClasses((prev) => (isPristineDefaultClasses(prev) ? [] : prev));
      setSelectedDatasetId("");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import dataset.");
    } finally {
      setImporting(false);
    }
  }

  function removeImportedClass(name: string) {
    setImportedClasses((prev) => {
      const target = prev.find((c) => c.name === name);
      if (target) revokeImportedPreviews([target]);
      return prev.filter((c) => c.name !== name);
    });
  }

  // Opens the lightbox scoped to just this imported action's OWN images
  // (only the ones with a real preview — "No preview" placeholders aren't
  // clickable) — ‹ › inside the lightbox then steps through that action
  // only, not the whole page's imports.
  function openImportedLightbox(images: ImportedImageDraft[], clickedKey: string) {
    const withPreview = images.filter((img) => img.previewUrl);
    const index = withPreview.findIndex((img) => img.key === clickedKey);
    if (index === -1) return;
    setLightbox({ images: withPreview.map((img) => img.previewUrl), index });
  }

  function removeImportedImage(className: string, key: string) {
    setImportedClasses((prev) =>
      prev
        .map((c) => {
          if (c.name !== className) return c;
          const target = c.images.find((img) => img.key === key);
          if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
          return { ...c, images: c.images.filter((img) => img.key !== key) };
        })
        .filter((c) => c.images.length > 0)
    );
  }

  async function addImagesToImportedClass(className: string, files: File[]) {
    if (files.length === 0) return;
    setImportUploadingClass(className);
    setImportError(null);
    try {
      for (const file of files) {
        const result = await uploadToGCS(file, "training-uploads");
        const previewUrl = URL.createObjectURL(file);
        setImportedClasses((prev) =>
          prev.map((c) =>
            c.name === className
              ? {
                  ...c,
                  images: [
                    ...c.images,
                    { key: `upload:${result.storage_path}`, ref: { storage_path: result.storage_path }, previewUrl },
                  ],
                }
              : c
          )
        );
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to upload image.");
    } finally {
      setImportUploadingClass(null);
    }
  }

  function startPolling(trainingJobId: string) {
    setPhase("training");
    const tick = async () => {
      try {
        const status = await api.train.status(trainingJobId);
        setTrainJob(status);
        if (status.status === "done" || status.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase(status.status === "done" ? "done" : "error");
          loadTrainingJobs();
        }
      } catch (err) {
        if (pollRef.current) clearInterval(pollRef.current);
        setPhase("error");
        setFormError(err instanceof Error ? err.message : "Lost connection while checking training status.");
      }
    };
    tick();
    pollRef.current = setInterval(tick, 3000);
  }

  async function handleRetry(trainingJobId: string) {
    setJobsListError(null);
    setRetryingId(trainingJobId);
    try {
      const job = await api.train.retry(trainingJobId);
      await loadTrainingJobs();
      // Also surface the retried job in the live-tracking card, same as a
      // freshly submitted one, so its progress is immediately visible.
      setTrainJob(job);
      setTab("train");
      startPolling(job.training_job_id);
    } catch (err) {
      setJobsListError(err instanceof Error ? err.message : "Failed to retry training.");
    } finally {
      setRetryingId(null);
    }
  }

  async function handleSubmit() {
    setFormError(null);

    const trimmedName = modelName.trim();
    const usable = classes
      .map((c) => ({ ...c, name: c.name.trim() }))
      .filter((c) => c.name && c.files.length > 0);

    if (!trimmedName) {
      setFormError("Give your model a name.");
      return;
    }
    if (usable.length + importedClasses.length < 2) {
      setFormError("Add at least 2 actions total (uploaded or imported), each with at least one image.");
      return;
    }
    if (splitSum !== 100) {
      setFormError("Train/val/test split must add up to 100%.");
      return;
    }
    const totalFiles = usable.reduce((sum, c) => sum + c.files.length, 0);
    let uploadedCount = 0;
    setPhase("uploading");
    setUploadProgress(0);

    try {
      const dataset: Record<string, TrainingImageRef[]> = {};
      // Imported classes are already-uploaded storage paths (fresh,
      // disposable copies from copy-for-training) — nothing to upload,
      // merge them straight in. Added first so a hand-built class sharing
      // the same name below extends rather than clobbers it.
      for (const ic of importedClasses) {
        dataset[ic.name] = ic.images.map((img) => img.ref);
      }
      for (const cls of usable) {
        const refs: TrainingImageRef[] = [];
        for (const file of cls.files) {
          setUploadLabel(`Uploading "${cls.name}" (${uploadedCount + 1}/${totalFiles})`);
          const result = await uploadToGCS(file, "training-uploads", (fraction: number) => {
            setUploadProgress((uploadedCount + fraction) / totalFiles);
          });
          refs.push({ storage_path: result.storage_path });
          uploadedCount += 1;
          setUploadProgress(uploadedCount / totalFiles);
        }
        dataset[cls.name] = [...(dataset[cls.name] ?? []), ...refs];
      }

      const job = await api.train.start({
        model_name: trimmedName,
        dataset,
        epochs,
        batch_size: batchSize,
        learning_rate: learningRate,
        split: { train: splitTrain / 100, val: splitVal / 100, test: splitTest / 100 },
      });
      setTrainJob(job);
      startPolling(job.training_job_id);
      loadTrainingJobs();
    } catch (err) {
      setPhase("error");
      setFormError(err instanceof Error ? err.message : "Failed to start training.");
    }
  }

  function resetForm() {
    setClasses([
      { id: newId(), name: "Action 1", files: [] },
      { id: newId(), name: "Action 2", files: [] },
    ]);
    setModelName("");
    setEpochs(DEFAULT_EPOCHS);
    setBatchSize(DEFAULT_BATCH_SIZE);
    setLearningRate(DEFAULT_LEARNING_RATE);
    setSplitTrain(DEFAULT_SPLIT.train);
    setSplitVal(DEFAULT_SPLIT.val);
    setSplitTest(DEFAULT_SPLIT.test);
    setShowAdvanced(false);
    setPhase("idle");
    setTrainJob(null);
    setFormError(null);
    revokeImportedPreviews(importedClasses);
    setImportedClasses([]);
    setSelectedDatasetId("");
    setImportError(null);
  }

  const isBusy = phase === "uploading" || phase === "training";

  return (
    <AppShell section="train" crumb="Train">
      <Container className="py-10">
        <PageHeader
          eyebrow="Train"
          title="Train a model"
          action={
            <Link href="/models" className={buttonClasses({ variant: "outline" })}>
              Model registry
            </Link>
          }
        />

        <Tabs
          tabs={[
            { id: "train", label: "Train a model" },
            { id: "jobs", label: "Training jobs" },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === "train" && (
          <div className="max-w-3xl space-y-6">
            <Card>
              <CardHeader title="Model details" />
              <div>
                <Label htmlFor="model-name">Model name</Label>
                <Input
                  id="model-name"
                  placeholder="e.g. math-game-screens-v1"
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  disabled={isBusy}
                />
              </div>

              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                disabled={isBusy}
                className="mt-4 text-sm font-medium text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                {showAdvanced ? "− Hide advanced options" : "+ Advanced options"}
              </button>

              {showAdvanced && (
                <div className="mt-4 grid gap-4 border-t border-neutral-100 pt-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="epochs">Training epochs</Label>
                    <Input
                      id="epochs"
                      type="number"
                      min={1}
                      max={500}
                      value={epochs}
                      onChange={(e) => setEpochs(Number(e.target.value) || 1)}
                      disabled={isBusy}
                    />
                  </div>
                  <div>
                    <Label htmlFor="batch-size">Batch size</Label>
                    <Input
                      id="batch-size"
                      type="number"
                      min={1}
                      max={256}
                      value={batchSize}
                      onChange={(e) => setBatchSize(Number(e.target.value) || 1)}
                      disabled={isBusy}
                    />
                  </div>
                  <div>
                    <Label htmlFor="learning-rate">Learning rate</Label>
                    <Input
                      id="learning-rate"
                      type="number"
                      step="0.0001"
                      min={0.0001}
                      max={1}
                      value={learningRate}
                      onChange={(e) => setLearningRate(Number(e.target.value) || DEFAULT_LEARNING_RATE)}
                      disabled={isBusy}
                    />
                  </div>
                  <div>
                    <Label>Train / val / test split (%)</Label>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={splitTrain}
                        onChange={(e) => setSplitTrain(Number(e.target.value) || 0)}
                        disabled={isBusy}
                        aria-label="Train split percentage"
                      />
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={splitVal}
                        onChange={(e) => setSplitVal(Number(e.target.value) || 0)}
                        disabled={isBusy}
                        aria-label="Validation split percentage"
                      />
                      <Input
                        type="number"
                        min={0}
                        max={100}
                        value={splitTest}
                        onChange={(e) => setSplitTest(Number(e.target.value) || 0)}
                        disabled={isBusy}
                        aria-label="Test split percentage"
                      />
                    </div>
                    <HelpText error={splitSum !== 100}>
                      {splitSum === 100
                        ? "Train / validation / test, in that order."
                        : `Must add up to 100% (currently ${splitSum}%).`}
                    </HelpText>
                  </div>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader
                title="Import from a saved dataset"
              />
              {datasets === null ? (
                <p className="text-sm text-neutral-500">Loading saved datasets…</p>
              ) : datasets.length === 0 ? (
                <p className="text-sm text-neutral-500">
                  No saved datasets yet.{" "}
                  <Link href="/create-actions" className="font-medium text-primary hover:underline">
                    Create one
                  </Link>{" "}
                  from a demo video first.
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="min-w-[240px] flex-1">
                      <Label htmlFor="import-dataset">Dataset</Label>
                      <Select
                        id="import-dataset"
                        value={selectedDatasetId}
                        onChange={(e) => setSelectedDatasetId(e.target.value)}
                        disabled={isBusy || importing}
                      >
                        <option value="">Choose a saved dataset…</option>
                        {datasets.map((d) => (
                          <option key={d.dataset_id} value={d.dataset_id}>
                            {d.name} ({d.classes.length} actions, {d.total_images} images)
                          </option>
                        ))}
                      </Select>
                    </div>
                    <Button
                      onClick={handleImport}
                      loading={importing}
                      disabled={isBusy || !selectedDatasetId || selectedImportClasses.size === 0}
                    >
                      Import
                    </Button>
                  </div>

                  {selectedDatasetId && (
                    <div className="flex flex-wrap gap-3 rounded-lg bg-neutral-50 p-3">
                      {datasets
                        .find((d) => d.dataset_id === selectedDatasetId)
                        ?.classes.map((c) => (
                          <label key={c.name} className="flex items-center gap-2 text-sm text-text">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-primary"
                              checked={selectedImportClasses.has(c.name)}
                              onChange={() => toggleImportClass(c.name)}
                            />
                            {c.name} <span className="text-neutral-500">({c.image_count})</span>
                          </label>
                        ))}
                    </div>
                  )}

                  {importError && <Alert tone="danger">{importError}</Alert>}

                  {importedClasses.length > 0 && (
                    <div className="space-y-3 border-t border-neutral-100 pt-3">
                      {importedClasses.map((ic) => (
                        <div key={ic.name} className="rounded-lg border border-neutral-200 p-3">
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <Badge tone="primary">{ic.name}</Badge>
                              <span className="text-sm text-neutral-500">
                                {ic.images.length} image{ic.images.length === 1 ? "" : "s"}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <label
                                className={`cursor-pointer ${importUploadingClass === ic.name || isBusy ? "pointer-events-none opacity-60" : ""}`}
                              >
                                <span className="inline-flex h-8 items-center rounded-lg border border-neutral-300 px-2.5 text-sm font-medium text-text hover:bg-neutral-100">
                                  {importUploadingClass === ic.name ? <Spinner size="sm" /> : "+ Add images"}
                                </span>
                                <input
                                  type="file"
                                  accept="image/*"
                                  multiple
                                  className="hidden"
                                  disabled={importUploadingClass === ic.name || isBusy}
                                  onChange={(e) => {
                                    addImagesToImportedClass(ic.name, Array.from(e.target.files ?? []));
                                    e.target.value = "";
                                  }}
                                />
                              </label>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => removeImportedClass(ic.name)}
                                disabled={isBusy}
                                aria-label={`Remove imported action ${ic.name}`}
                              >
                                Remove action
                              </Button>
                            </div>
                          </div>
                          {ic.images.length > 0 && (
                            <div className="grid grid-cols-6 gap-2 sm:grid-cols-8 lg:grid-cols-10">
                              {ic.images.map((img) => (
                                <div key={img.key} className="group relative aspect-square overflow-hidden rounded-lg border border-neutral-200">
                                  {img.previewUrl ? (
                                    <button
                                      type="button"
                                      onClick={() => openImportedLightbox(ic.images, img.key)}
                                      className="block h-full w-full cursor-zoom-in"
                                      aria-label="View full size"
                                    >
                                      {/* Local/proxied blob: object URLs — next/image can't optimize these. */}
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img src={img.previewUrl} alt="" className="h-full w-full object-cover" />
                                    </button>
                                  ) : (
                                    <div className="flex h-full w-full items-center justify-center bg-neutral-100 text-xs text-neutral-400">
                                      No preview
                                    </div>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => removeImportedImage(ic.name, img.key)}
                                    aria-label="Remove image"
                                    disabled={isBusy}
                                    className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/70 text-xs text-white group-hover:flex disabled:pointer-events-none"
                                  >
                                    ×
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>

            {classes.map((cls, i) => (
              <Card key={cls.id}>
                <div className="mb-4 flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <Label htmlFor={`class-name-${cls.id}`}>Action {i + 1} name</Label>
                    <Input
                      id={`class-name-${cls.id}`}
                      value={cls.name}
                      onChange={(e) => renameClass(cls.id, e.target.value)}
                      disabled={isBusy}
                    />
                  </div>
                  {classes.length + importedClasses.length > 2 && (
                    <Button variant="ghost" size="sm" onClick={() => removeClass(cls.id)} disabled={isBusy}>
                      Remove
                    </Button>
                  )}
                </div>
                <ImageDropzone files={cls.files} onChange={(f) => setClassFiles(cls.id, f)} disabled={isBusy} />
              </Card>
            ))}

            <div className="flex flex-wrap items-center gap-4">
              <Button variant="outline" onClick={addClass} disabled={isBusy}>
                + Add another action
              </Button>
              {phase === "idle" && (
                <Button size="lg" onClick={handleSubmit}>
                  Start training
                </Button>
              )}
            </div>

            {formError && <Alert tone="danger">{formError}</Alert>}

            {phase === "uploading" && (
              <Card>
                <p className="mb-2 text-sm font-medium text-text">{uploadLabel}</p>
                <ProgressBar fraction={uploadProgress} />
              </Card>
            )}

            {(phase === "training" || phase === "done" || phase === "error") && trainJob && (
              <Card>
                <CardHeader
                  title="Training job"
                  description={`"${trainJob.model_name}"`}
                  action={<StatusBadge status={trainJob.status} />}
                />
                {phase === "training" && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 text-sm text-neutral-600">
                      <Spinner size="sm" />
                      {progressLabel(trainJob.progress) ||
                        "Training in progress — this can take a few minutes depending on dataset size and epochs."}
                    </div>
                    {trainJob.progress?.stage === "training_cnn" &&
                      trainJob.progress.epoch != null &&
                      trainJob.progress.epochs != null && (
                        <ProgressBar fraction={trainJob.progress.epoch / trainJob.progress.epochs} />
                      )}
                  </div>
                )}
                {phase === "error" && (
                  <Alert tone="danger" title="Training failed">
                    {trainJob.error || "Something went wrong during training."}
                  </Alert>
                )}
                {phase === "done" && trainJob.metrics && (
                  <div className="space-y-6">
                    <MetricsReport title="CNN-only" metrics={trainJob.metrics.cnn_only} />
                    {trainJob.metrics.text_only && (
                      <MetricsReport title="OCR text-only" metrics={trainJob.metrics.text_only} />
                    )}
                    {trainJob.metrics.combined && (
                      <MetricsReport
                        title={`Combined (fusion α = ${trainJob.metrics.fusion_alpha})`}
                        metrics={trainJob.metrics.combined}
                        note={ocrExcludedNote(trainJob.metrics)}
                      />
                    )}
                    {!trainJob.metrics.combined && (
                      <p className="text-sm text-neutral-500">
                        Not enough legible on-screen text was found to train a text classifier — this model runs
                        CNN-only, which is completely fine.
                      </p>
                    )}
                  </div>
                )}
                {(phase === "done" || phase === "error") && (
                  <Button variant="outline" size="sm" className="mt-4" onClick={resetForm}>
                    Train another model
                  </Button>
                )}
              </Card>
            )}
          </div>
        )}

        {tab === "jobs" && (
          <div>
            <CardHeader title="Training jobs" />
            {jobsListError && (
              <Alert tone="danger" className="mb-4">
                {jobsListError}
              </Alert>
            )}
            {trainingJobs === null ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
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
            ) : trainingJobs.length === 0 ? (
              <EmptyState title="No training jobs yet" />
            ) : (
              <div className="space-y-3">
                {trainingJobs.map((job, i) => (
                  <Card key={job.training_job_id} className="animate-fade-in-up p-4" style={stagger(i, 40)}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-text">{job.model_name}</p>
                        <p className="text-sm text-neutral-500">
                          {job.class_names?.join(", ") || "—"} · {formatDate(job.created_at)}
                          {job.retry_count > 0 && ` · retried ${job.retry_count}×`}
                          {isRetryable(job) && (job.status === "queued" || job.status === "processing") && (
                            <span className="text-warning">
                              {" "}
                              · stuck?{" "}
                              {job.status === "queued"
                                ? "worker may not have picked it up"
                                : "may have crashed mid-training"}
                            </span>
                          )}
                        </p>
                        {job.status === "processing" && job.progress && (
                          <p className="mt-1 text-sm text-neutral-500">{progressLabel(job.progress)}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={job.status} />
                        {isRetryable(job) && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRetry(job.training_job_id)}
                            loading={retryingId === job.training_job_id}
                          >
                            Retry
                          </Button>
                        )}
                        {(job.status === "done" || job.status === "failed") && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setExpandedJobId(expandedJobId === job.training_job_id ? null : job.training_job_id)
                            }
                          >
                            {expandedJobId === job.training_job_id ? "Hide details" : "View details"}
                          </Button>
                        )}
                      </div>
                    </div>

                    {expandedJobId === job.training_job_id && (
                      <div className="mt-4 border-t border-neutral-100 pt-4">
                        {job.status === "failed" && (
                          <Alert tone="danger" title="Training failed">
                            {job.error || "Something went wrong during training."}
                          </Alert>
                        )}
                        {job.status === "done" && job.metrics && (
                          <div className="space-y-6">
                            <MetricsReport title="CNN-only" metrics={job.metrics.cnn_only} />
                            {job.metrics.text_only && (
                              <MetricsReport title="OCR text-only" metrics={job.metrics.text_only} />
                            )}
                            {job.metrics.combined && (
                              <MetricsReport
                                title={`Combined (fusion α = ${job.metrics.fusion_alpha})`}
                                metrics={job.metrics.combined}
                                note={ocrExcludedNote(job.metrics)}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

      </Container>

      <ImageLightbox
        images={lightbox?.images ?? []}
        index={lightbox?.index ?? 0}
        onIndexChange={(index) => setLightbox((prev) => (prev ? { ...prev, index } : prev))}
        onClose={() => setLightbox(null)}
      />
    </AppShell>
  );
}

export default function TrainPage() {
  return (
    <ProtectedRoute>
      <TrainContent />
    </ProtectedRoute>
  );
}
