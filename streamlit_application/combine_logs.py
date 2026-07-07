import csv
import logging
import sys
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Configuration ──────────────────────────────────────────────────────────────
LOGS_DIR = "/Volumes/Pankaj_SSD/In game perfortmance/Video_Logs2"
OUTPUT_CSV = "/Volumes/Pankaj_SSD/In game perfortmance/combined_logs_focus.csv"
# ───────────────────────────────────────────────────────────────────────────────


def extract_id(filename: str) -> str:
    """Return the token before the first space in the filename stem."""
    return Path(filename).stem.split(" ")[0]


def combine_logs(logs_dir: str, output_path: str) -> None:
    logs_dir_path = Path(logs_dir)
    if not logs_dir_path.exists():
        log.error("Logs directory not found: %s", logs_dir)
        sys.exit(1)

    csv_files = sorted(logs_dir_path.glob("*.csv"))
    if not csv_files:
        log.warning("No CSV files found in %s", logs_dir)
        return

    log.info("Found %d CSV file(s) to combine.", len(csv_files))

    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    written_rows = 0
    skipped_files = 0

    with open(output_path, "w", newline="") as out_f:
        writer = None  # initialised on first file

        for csv_file in csv_files:
            video_id = extract_id(csv_file.name)

            try:
                with open(csv_file, "r", newline="") as in_f:
                    reader = csv.DictReader(in_f)

                    if reader.fieldnames is None:
                        log.warning("SKIP (empty): %s", csv_file.name)
                        skipped_files += 1
                        continue

                    if writer is None:
                        fieldnames = ["video_id"] + list(reader.fieldnames)
                        writer = csv.DictWriter(out_f, fieldnames=fieldnames)
                        writer.writeheader()

                    file_rows = 0
                    for row in reader:
                        writer.writerow({"video_id": video_id, **row})
                        file_rows += 1

                log.info("  %-45s  id=%-6s  %d rows", csv_file.name, video_id, file_rows)
                written_rows += file_rows

            except Exception as e:
                log.error("FAILED %s: %s", csv_file.name, e)
                skipped_files += 1

    log.info(
        "Done — %d rows written from %d file(s) → %s  (%d skipped)",
        written_rows, len(csv_files) - skipped_files, output_path, skipped_files,
    )


if __name__ == "__main__":
    combine_logs(LOGS_DIR, OUTPUT_CSV)
