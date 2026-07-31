import type { TrainingMetrics } from "./types";

/** Actions forced to CNN-only because OCR was judged unreliable for them
 * during training (see backend's PER_CLASS_OCR_EXCLUDE_MARGIN) — shown as a
 * caption under the "Combined" report so it's clear why those actions'
 * numbers match the CNN-only report instead of a blend. Shared between the
 * training page's live/history views and the model detail page. */
export function ocrExcludedNote(metrics: TrainingMetrics): string | null {
  if (!metrics.fusion_alpha_per_class) return null;
  const excluded = Object.entries(metrics.fusion_alpha_per_class)
    .filter(([, alpha]) => alpha >= 1 && metrics.fusion_alpha < 1)
    .map(([actionName]) => actionName);
  if (excluded.length === 0) return null;
  return `CNN-only for ${excluded.join(", ")} — OCR text wasn't reliable enough for ${excluded.length === 1 ? "this action" : "these actions"}.`;
}
