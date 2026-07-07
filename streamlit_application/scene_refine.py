import pandas as pd
import os

# input and output folders
input_folder = "scenes"
output_folder = "scenes_new"

# make sure output folder exists
os.makedirs(output_folder, exist_ok=True)

# loop over all CSV files in scenes/
for file in os.listdir(input_folder):
    if file.endswith(".csv"):
        input_path = os.path.join(input_folder, file)
        output_path = os.path.join(output_folder, file)

        # read CSV
        df = pd.read_csv(input_path)

        # convert duration to timedelta
        df["duration"] = pd.to_timedelta(df["duration"])

        # filter out rows <= 1 second
        df = df[df["duration"] > pd.Timedelta(seconds=1)]

        # save to scenes_new/ with same filename
        df.to_csv(output_path, index=False)

        print(f"Processed {file} → {output_path}")
