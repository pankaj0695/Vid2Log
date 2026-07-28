// Small shared display-formatting helpers used across the Process and
// Analytics pages.

/** A video-processing job is named after the uploaded video
 * ("recording.mp4"), but what's actually shown everywhere in the UI is a
 * LOG — the CSV-shaped table of scenes vid2log extracted from that video,
 * not the video itself (which no longer even exists once processing
 * finishes, see video_pipeline.py). Swapping the extension for display
 * keeps every log's name consistent with what it actually is, regardless
 * of whether it came from video processing (original_filename ends in
 * .mp4/.mov/etc.) or a direct CSV import (original_filename is already
 * .csv, so this is a no-op there). */
export function logDisplayName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "");
  return `${base || name}.csv`;
}
