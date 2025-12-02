# summary section
import pandas as pd
import os

# input and output folders
input_folder = "scenes_neww"  # processed CSVs
output_folder = "scenes_final"  # final CSVs with summary
os.makedirs(output_folder, exist_ok=True)

for file in os.listdir(input_folder):
    if file.endswith(".csv"):
        input_path = os.path.join(input_folder, file)
        output_path = os.path.join(output_folder, file)

        # read CSV
        df = pd.read_csv(input_path)

        # convert duration to timedelta for aggregation
        df['duration_td'] = pd.to_timedelta(df['duration'])

        # create summary table
        summary = df.groupby('class', dropna=False)['duration_td'].sum().reset_index()
        summary.rename(columns={'duration_td': 'total_duration'}, inplace=True)

        # format total_duration to HH:MM:SS
        summary['total_duration'] = summary['total_duration'].apply(lambda x: str(x).split(' days')[-1].strip())

        # append 3 empty rows for gap
        empty_rows = pd.DataFrame([['', '', '', '']] * 3, columns=df.columns)
        df_final = pd.concat([df, empty_rows], ignore_index=True)

        # append summary table (ensure columns match)
        summary_rows = summary.rename(columns={'class': 'class', 'total_duration': 'duration'})
        summary_rows['start_time'] = ''
        summary_rows['end_time'] = ''
        summary_rows = summary_rows[['start_time', 'end_time', 'duration', 'class']]

        df_final = pd.concat([df_final, summary_rows], ignore_index=True)

        # save final CSV
        df_final.to_csv(output_path, index=False)
        print(f"✅ Final CSV with summary saved: {output_path}")
