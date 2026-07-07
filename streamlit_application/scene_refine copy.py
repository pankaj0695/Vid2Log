# filter out rows <= 1 second and split long scenes
import pandas as pd
import os
from datetime import timedelta

# input and output folders
input_folder = "scenes"
output_folder = "scenes_neww"

# make sure output folder exists
os.makedirs(output_folder, exist_ok=True)

def format_timedelta(td: timedelta) -> str:
    """Convert timedelta to strict HH:MM:SS format with 2-digit hours."""
    total_seconds = int(td.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"

# loop over all CSV files in scenes/
for file in os.listdir(input_folder):
    if file.endswith(".csv"):
        input_path = os.path.join(input_folder, file)
        output_path = os.path.join(output_folder, file)

        # read CSV
        df = pd.read_csv(input_path)

        # normalize column names
        df.columns = df.columns.str.strip().str.lower()

        # make sure duration column exists
        if "duration" not in df.columns:
            print(f"⚠️ Skipping {file}: no 'duration' column found.")
            continue

        # convert duration to timedelta
        df["duration"] = pd.to_timedelta(df["duration"])

        # filter out rows <= 1 second
        df = df[df["duration"] > pd.Timedelta(seconds=1)]

        # split rows longer than 5 seconds and format durations inline
        new_rows = []
        for _, row in df.iterrows():
            row_start = pd.to_timedelta(row["start_time"])
            row_end = pd.to_timedelta(row["end_time"])

            if row["duration"] > pd.Timedelta(seconds=5):
                # capped action row (5 seconds)
                capped_row = row.copy()
                capped_row["duration"] = format_timedelta(pd.Timedelta(seconds=5))
                capped_row["start_time"] = format_timedelta(row_start)
                capped_row["end_time"] = format_timedelta(row_start + pd.Timedelta(seconds=5))
                new_rows.append(capped_row)

                # idle row with leftover duration
                idle_row = row.copy()
                idle_row["class"] = "idle"
                leftover = row["duration"] - pd.Timedelta(seconds=5)
                idle_row["duration"] = format_timedelta(leftover)
                idle_row["start_time"] = format_timedelta(row_start + pd.Timedelta(seconds=5))
                idle_row["end_time"] = format_timedelta(row_end)
                new_rows.append(idle_row)
            else:
                row = row.copy()
                row["duration"] = format_timedelta(row["duration"])
                row["start_time"] = format_timedelta(row_start)
                row["end_time"] = format_timedelta(row_end)
                new_rows.append(row)

        # rebuild DataFrame
        df = pd.DataFrame(new_rows)

        # --- build summary table ---
        summary = (
            df.assign(duration=pd.to_timedelta(df["duration"]))
            .groupby("class")
            .agg(
                frequency=("class", "count"),
                duration=("duration", lambda x: format_timedelta(x.sum()))
            )
            .reset_index()
        )

        # 3 blank rows matching df column count
        blank = pd.DataFrame([[""] * len(df.columns)] * 3, columns=df.columns)

        # prepare summary table with correct column order
        summary_expanded = pd.DataFrame(columns=df.columns)
        summary_expanded["class"] = summary["class"]
        summary_expanded["duration"] = summary["duration"]
        summary_expanded["frequency"] = summary["frequency"]  # extra column

        # ensure CSV column order: start_time | end_time | class | duration | frequency
        summary_expanded = summary_expanded[["start_time", "end_time", "class", "duration", "frequency"]]

        # concat main df + blank + summary
        final_df = pd.concat([df, blank, summary_expanded], ignore_index=True)

        # save to scenes_neww/ with same filename
        final_df.to_csv(output_path, index=False)

        print(f"✅ Processed {file} → {output_path}")
