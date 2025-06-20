import os
import csv
import cv2
import numpy as np
from keras.models import load_model
from PIL import Image, ImageOps
from datetime import timedelta

# Configuration
INPUT_VIDEO = "input_video/input_video.mkv"  # Relative path to your video
FPS = 2  # Frames to process per second
MODEL_PATH = "converted_keras/keras_Model.h5"
LABELS_PATH = "converted_keras/labels.txt"
OUTPUT_CSV = "scene_classification.csv"

# Load model and labels
model = load_model(MODEL_PATH, compile=False)
class_names = [line.strip() for line in open(LABELS_PATH, "r").readlines()]

def classify_image(image):
    image = ImageOps.fit(image, (224, 224), Image.Resampling.LANCZOS)
    image_array = np.asarray(image)
    normalized_image_array = (image_array.astype(np.float32) / 127.5) - 1
    data = np.expand_dims(normalized_image_array, axis=0)
    prediction = model.predict(data)
    return class_names[np.argmax(prediction)], np.max(prediction)

def process_video():
    """Main processing function"""
    cap = cv2.VideoCapture(INPUT_VIDEO)
    video_fps = cap.get(cv2.CAP_PROP_FPS)
    frame_interval = int(video_fps // FPS)
    
    scenes = []
    current_class = None
    start_time = 0
    frame_count = 0

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
        
        frame_count += 1
        if frame_count % frame_interval != 0:
            continue
        
        timestamp = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000  # Current time in seconds
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = Image.fromarray(frame_rgb).convert("RGB")
        class_label, confidence = classify_image(image)
        
        if class_label != current_class:
            if current_class is not None:  # Save previous scene
                scenes.append({
                    "start": start_time,
                    "end": timestamp,
                    "duration": timestamp - start_time,
                    "class": current_class
                })
            current_class = class_label
            start_time = timestamp
    
    # Add the last scene
    if current_class is not None:
        scenes.append({
            "start": start_time,
            "end": timestamp,
            "duration": timestamp - start_time,
            "class": current_class
        })
    
    cap.release()
    return scenes

def write_to_csv(scenes):
    """Write scene data to CSV"""
    with open(OUTPUT_CSV, 'w', newline='') as csvfile:
        fieldnames = ['start_time', 'end_time', 'duration', 'class']
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        
        writer.writeheader()
        for scene in scenes:
            writer.writerow({
                'start_time': str(timedelta(seconds=scene["start"])),
                'end_time': str(timedelta(seconds=scene["end"])),
                'duration': str(timedelta(seconds=scene["duration"])),
                'class': scene["class"]
            })

if __name__ == "__main__":
    print("Processing video...")
    scenes = process_video()
    write_to_csv(scenes)
    print(f"Done! Results saved to {OUTPUT_CSV}")