// Shared TypeScript types mirroring backend/app/schemas.py — keep in sync
// with the FastAPI response_models when the backend contract changes.

export type UserRole = "user" | "admin";

export interface UserProfile {
  uid: string;
  email: string | null;
  display_name: string | null;
  role: UserRole;
  created_at: string | null;
}

export type JobStatus = "queued" | "processing" | "done" | "failed" | "cancelled";

export interface JobOut {
  job_id: string;
  status: JobStatus;
  original_filename: string;
  display_name: string | null;
  model_id: string | null;
  scene_count: number | null;
  error: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface SceneRow {
  start_time: string;
  end_time: string;
  duration: string;
  class: string;
  confidence: number;
  source?: "cnn" | "keyword_rule" | "fusion" | "cnn_per_class_override";
}

export interface LogOut {
  job_id: string;
  original_filename: string;
  scenes: SceneRow[];
}

export interface PerClassMetric {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface EvalMetrics {
  accuracy: number;
  per_class: Record<string, PerClassMetric>;
  confusion_matrix: number[][];
  test_set_size: number;
}

export interface TrainingMetrics {
  cnn_only: EvalMetrics;
  text_only: EvalMetrics | null;
  combined: EvalMetrics | null;
  fusion_alpha: number;
  // class_name -> alpha; 1.0 means that class is forced CNN-only because
  // OCR was judged unreliable for it. null if OCR fusion wasn't used at
  // all (see backend/app/services/training_pipeline.py::_compute_per_class_alpha).
  fusion_alpha_per_class: Record<string, number> | null;
}

export type TrainJobStatus = "queued" | "processing" | "done" | "failed";

export type TrainStage =
  | "starting"
  | "downloading"
  | "training_cnn"
  | "evaluating_cnn"
  | "extracting_text"
  | "tuning_fusion"
  | "saving_model";

export interface TrainProgress {
  stage: TrainStage | string;
  detail: string | null;
  epoch: number | null;
  epochs: number | null;
  accuracy: number | null;
  loss: number | null;
  val_accuracy: number | null;
}

export interface TrainJobOut {
  training_job_id: string;
  status: TrainJobStatus;
  model_name: string;
  model_id: string | null;
  metrics: TrainingMetrics | null;
  error: string | null;
  created_at: string | null;
  started_at: string | null;
  class_names: string[] | null;
  progress: TrainProgress | null;
  retry_count: number;
  epochs: number | null;
  batch_size: number | null;
  learning_rate: number | null;
  split: SplitRatios | null;
}

export interface ModelOut {
  model_id: string;
  name: string;
  labels: string[];
  model_storage_path: string;
  metrics: TrainingMetrics | null;
  dataset_version: string | null;
  is_active: boolean;
  created_at: string | null;
  text_model_storage_path: string | null;
  fusion_alpha: number | null;
  fusion_alpha_per_class: Record<string, number> | null;
  keyword_rules: Record<string, string[]> | null;
}

export interface TrainingImageRef {
  storage_path: string;
}

export interface SplitRatios {
  train: number;
  val: number;
  test: number;
}

export interface SPMPattern {
  pattern: string[];
  support: number; // S-Frequency
  support_fraction: number; // S-Support
  i_frequency: number;
  i_support_mean: number;
  i_support_sd: number;
}

export type SPMSortBy = "s_support" | "i_support";

export type DSMTestType =
  | "ttest_ind"
  | "poisson_means_test"
  | "mannwhitneyu"
  | "bws_test"
  | "ranksums"
  | "brunnermunzel"
  | "mood"
  | "ansari"
  | "cramervonmises_2samp"
  | "epps_singleton_2samp"
  | "ks_2samp"
  | "kstest";

export interface DSMPattern {
  pattern: string[];
  p_value: number;
  isupport_left_mean: number | null;
  isupport_right_mean: number | null;
  group: "left" | "right";
}

export interface AdminStats {
  total_users: number;
  total_admins: number;
  total_jobs: number;
  jobs_by_status: Record<string, number>;
  total_models: number;
  active_model_id: string | null;
  total_training_jobs: number;
}
