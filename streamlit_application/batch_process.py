import os
import sys
import time
import logging
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Configuration ──────────────────────────────────────────────────────────────
VIDEO_DIR = "/Volumes/Pankaj_SSD/In game perfortmance/Remaining_Videos"
OUTPUT_DIR = "/Volumes/Pankaj_SSD/In game perfortmance/Remaining_Videos_Output"
FPS = 2  # frames per second to sample
SKIP_EXISTING = True  # skip videos whose CSV already exists
VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".MP4", ".AVI", ".MOV", ".MKV"}
# ───────────────────────────────────────────────────────────────────────────────


def find_videos(directory: str) -> list[Path]:
    video_dir = Path(directory)
    if not video_dir.exists():
        log.error("Video directory not found: %s", directory)
        sys.exit(1)
    videos = sorted(
        p for p in video_dir.iterdir()
        if p.is_file() and p.suffix in VIDEO_EXTENSIONS
    )
    return videos


def csv_path_for(video: Path, output_dir: Path) -> Path:
    return output_dir / (video.stem + ".csv")


def main():
    from streamlit_application.video_processor import process_video, write_to_csv

    output_dir = Path(OUTPUT_DIR)
    output_dir.mkdir(parents=True, exist_ok=True)

    videos = find_videos(VIDEO_DIR)
    if not videos:
        log.warning("No video files found in %s", VIDEO_DIR)
        return

    total = len(videos)
    log.info("Found %d video(s) to process. Output → %s", total, output_dir)

    skipped, succeeded, failed = 0, 0, 0
    overall_start = time.time()

    for idx, video in enumerate(videos, start=1):
        out_csv = csv_path_for(video, output_dir)

        if SKIP_EXISTING and out_csv.exists():
            log.info("[%d/%d] SKIP (already done): %s", idx, total, video.name)
            skipped += 1
            continue

        log.info("[%d/%d] Processing: %s", idx, total, video.name)
        t0 = time.time()

        try:
            scenes = process_video(str(video), fps=FPS)
            write_to_csv(scenes, str(out_csv))
            elapsed = time.time() - t0
            log.info(
                "[%d/%d] Done in %.1fs — %d scenes → %s",
                idx, total, elapsed, len(scenes), out_csv.name,
            )
            succeeded += 1
        except Exception as e:
            elapsed = time.time() - t0
            log.error(
                "[%d/%d] FAILED after %.1fs: %s — %s",
                idx, total, elapsed, video.name, e,
            )
            failed += 1

    total_elapsed = time.time() - overall_start
    log.info(
        "Batch complete in %.1fs — %d succeeded, %d skipped, %d failed",
        total_elapsed, succeeded, skipped, failed,
    )


if __name__ == "__main__":
    main()
