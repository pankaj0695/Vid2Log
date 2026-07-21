"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppShell } from "@/components/app-shell/AppShell";
import { api } from "@/lib/api";
import { uploadToGCS } from "@/lib/gcs";
import type { ModelOut, TrainingImageRef, TrainJobOut, TrainProgress } from "@/lib/types";
import { ocrExcludedNote } from "@/lib/trainingMetrics";
import { Container, PageHeader } from "@/components/ui/Section";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Input, Label, HelpText } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Spinner } from "@/components/ui/Spinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Tabs } from "@/components/ui/Tabs";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ImageDropzone } from "@/components/train/ImageDropzone";
import { MetricsReport } from "@/components/train/MetricsReport";

interface ClassDraft {
  id: string;
  name: string;
  files: File[];
}

let idCounter = 0;
function newId() {
  idCounter += 1;
  return `class-${idCounter}-${Date.now()}`;
}

type Tab = "train" | "jobs" | "registry";

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
    { id: newId(), name: "Class 1", files: [] },
    { id: newId(), name: "Class 2", files: [] },
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

  const [models, setModels] = useState<ModelOut[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  const [renamingModelId, setRenamingModelId] = useState<string | null>(null);
  const [renameModelValue, setRenameModelValue] = useState("");
  const [renameModelBusy, setRenameModelBusy] = useState(false);
  const [renameModelError, setRenameModelError] = useState<string | null>(null);

  const [deleteModelTarget, setDeleteModelTarget] = useState<ModelOut | null>(null);
  const [deleteModelBusy, setDeleteModelBusy] = useState(false);

  // Job history — lets a failed job (e.g. a local TensorFlow crash) be
  // retried without re-uploading images, instead of only ever seeing the
  // single most-recently-submitted job.
  const [trainingJobs, setTrainingJobs] = useState<TrainJobOut[] | null>(null);
  const [jobsListError, setJobsListError] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadModels() {
    setModelsError(null);
    try {
      setModels(await api.models.list());
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : "Failed to load model registry.");
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
    loadModels();
    loadTrainingJobs();
    prefillFromRetrainQuery();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    const hasActive = trainingJobs?.some((j) => ACTIVE_TRAIN_STATUSES.has(j.status));
    if (!hasActive) return;
    const interval = setInterval(loadTrainingJobs, 4000);
    return () => clearInterval(interval);
  }, [trainingJobs]);

  function addClass() {
    setClasses((c) => [...c, { id: newId(), name: `Class ${c.length + 1}`, files: [] }]);
  }

  function removeClass(id: string) {
    setClasses((c) => (c.length <= 2 ? c : c.filter((cl) => cl.id !== id)));
  }

  function renameClass(id: string, name: string) {
    setClasses((c) => c.map((cl) => (cl.id === id ? { ...cl, name } : cl)));
  }

  function setClassFiles(id: string, files: File[]) {
    setClasses((c) => c.map((cl) => (cl.id === id ? { ...cl, files } : cl)));
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
          if (status.status === "done") loadModels();
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
    if (usable.length < 2) {
      setFormError("Add at least 2 classes, each with a name and at least one image.");
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
        dataset[cls.name] = refs;
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

  async function handleActivate(modelId: string) {
    setActivatingId(modelId);
    try {
      await api.models.activate(modelId);
      await loadModels();
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : "Failed to activate model.");
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
      setModelsError(err instanceof Error ? err.message : "Failed to delete model.");
    } finally {
      setDeleteModelBusy(false);
    }
  }

  function resetForm() {
    setClasses([
      { id: newId(), name: "Class 1", files: [] },
      { id: newId(), name: "Class 2", files: [] },
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
  }

  const isBusy = phase === "uploading" || phase === "training";

  return (
    <AppShell section="train" crumb="Train">
      <Container className="py-10">
        <PageHeader
          eyebrow="Train"
          title="Train a model"
          description="Create a class for every action or screen you want recognized, add ~20–25 example images each, and vid2log will fine-tune a classifier and report real test-set metrics."
        />

        <Tabs
          tabs={[
            { id: "train", label: "Train a model" },
            { id: "jobs", label: "Training jobs" },
            { id: "registry", label: "Model registry" },
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
                    <HelpText>More epochs can improve accuracy but take longer to train.</HelpText>
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
                    <HelpText>Images processed per training step.</HelpText>
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
                    <HelpText>Lower values train more slowly but can be more stable.</HelpText>
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

            {classes.map((cls, i) => (
              <Card key={cls.id}>
                <div className="mb-4 flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <Label htmlFor={`class-name-${cls.id}`}>Class {i + 1} name</Label>
                    <Input
                      id={`class-name-${cls.id}`}
                      value={cls.name}
                      onChange={(e) => renameClass(cls.id, e.target.value)}
                      disabled={isBusy}
                    />
                  </div>
                  {classes.length > 2 && (
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
                + Add another class
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
            <CardHeader
              title="Training jobs"
              description="Your training history. A failed job — or one stuck 'queued'/'processing' for a while — keeps its uploaded images, so you can retry it without uploading anything again. A retry reuses the same job, it won't create a duplicate entry."
            />
            {jobsListError && (
              <Alert tone="danger" className="mb-4">
                {jobsListError}
              </Alert>
            )}
            {trainingJobs === null ? (
              <Spinner label="Loading training jobs..." />
            ) : trainingJobs.length === 0 ? (
              <EmptyState title="No training jobs yet" description="Train a model to see its history here." />
            ) : (
              <div className="space-y-3">
                {trainingJobs.map((job) => (
                  <Card key={job.training_job_id} className="p-4">
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

        {tab === "registry" && (
          <Card>
            <CardHeader title="Model registry" description="Activate the model new video jobs should use by default." />
            {modelsError && (
              <Alert tone="danger" className="mb-3">
                {modelsError}
              </Alert>
            )}
            {models === null ? (
              <Spinner label="Loading models..." />
            ) : models.length === 0 ? (
              <EmptyState title="No models yet" description="Train your first model to see it here." />
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {models.map((m) => (
                  <li key={m.model_id} className="rounded-lg border border-neutral-200 p-4">
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
                            <p className="text-sm text-neutral-500">{m.labels.length} classes</p>
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
                              Set as active
                            </Button>
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
        )}
      </Container>

      <ConfirmDialog
        open={deleteModelTarget !== null}
        title="Delete this model?"
        description={
          deleteModelTarget && (
            <>
              This permanently deletes <span className="font-medium text-text">{deleteModelTarget.name}</span> and its
              saved files. This can&apos;t be undone.
              {deleteModelTarget.is_active && (
                <p className="mt-2 text-warning">
                  This is your currently active model — new video jobs will have no default model until you activate
                  another one.
                </p>
              )}
            </>
          )
        }
        confirmLabel="Delete model"
        busy={deleteModelBusy}
        onConfirm={confirmDeleteModel}
        onCancel={() => setDeleteModelTarget(null)}
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
