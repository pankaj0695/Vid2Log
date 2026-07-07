import os
import csv
import cv2
import numpy as np
from keras.models import load_model
from PIL import Image, ImageOps
from datetime import timedelta

# Configuration
INPUT_VIDEO = "input_video/2025-02-02 14-19-35.mkv"  # Relative path to your video
FPS = 2  # Frames to process per second
OUTPUT_CSV = "scenes/scene_classification_6_____6__6__.csv"
FRAMES_DIR = "extracted_frames" 

model = load_model("new model/v2imp1_converted_keras_resized/keras_Model.h5", compile=False)
class_names = [line.strip() for line in open("new model/v2imp1_converted_keras_resized/labels.txt", "r").readlines()]
class_names.extend(["10 Class 11 code reference","11 Class 12 socials","12 Class 13 split window"])
model2 = load_model("new model/imp1_converted_keras_split/keras_model.h5", compile=False)
class_names2 = [line.strip() for line in open("new model/imp1_converted_keras_split/labels.txt", "r").readlines()]

import pytesseract
from PIL import Image
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
def classify_addBar(full_img):
    width, height = full_img.size
    address_bar_region = (0, 0, width, 250)  # (left, top, right, bottom)
    cropped_img = full_img.crop(address_bar_region)
    text = pytesseract.image_to_string(cropped_img)
    #print(text) if "vid2log" not in text else ()
    if('docs.google.com' in text or 'docs.googlecom' in text or 'docs. google.com' in text):
        return (4)
    elif('reddit.com' in text or 'whatsapp.com' in text or 'mail.google.com' in text or 'mailgooglecom' in text or 'mailgoogle.com' in text):
        return (11)
    elif('google.com' in text):
        return (0)
    elif('File' in text and 'Edit' in text and 'Selection' in text and 'View' in text and 'Go' in text and 'Run' in text):
        return (5)
    elif('github.com' in text):
        return (2)
    elif('localhost:' in text or 'localhost8501' in text):
        return (8)
    elif('stackoverflow.com' in text or 'geeksforgeeks.org' in text):
        return (10)
    return (-1)

def resize_with_padding(img, output_size=(224, 224), pad_color=(0, 0, 0)):
    original_width, original_height = img.size
    target_width, target_height = output_size
    scale = min(target_width / original_width, target_height / original_height)
    new_width = int(original_width * scale)
    new_height = int(original_height * scale)
    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    padded_img = Image.new("RGB", (target_width, target_height), pad_color)
    x_offset = (target_width - new_width) // 2
    y_offset = (target_height - new_height) // 2
    padded_img.paste(img, (x_offset, y_offset))
    
    return padded_img

def classify_image(image):
    based_on_addbar=classify_addBar(image)
    image = resize_with_padding(image)
    image_array = np.asarray(image)
    normalized_image_array = (image_array.astype(np.float32) / 127.5) - 1
    data = np.expand_dims(normalized_image_array, axis=0)
    prediction = model.predict(data)
    
    prediction2=model2.predict(data)
    if np.argmax(prediction2)==1:
        return class_names[12], np.max(prediction2)

    if based_on_addbar>-1:
        return class_names[based_on_addbar], prediction[0][based_on_addbar] if based_on_addbar<10 else 1.0
    else:
        return class_names[np.argmax(prediction)], np.max(prediction)
def extract_frames():
    """Extract frames from video and save to disk"""
    cap = cv2.VideoCapture(INPUT_VIDEO)
    video_fps = cap.get(cv2.CAP_PROP_FPS)
    frame_interval = int(video_fps // FPS)
    frame_count = 0
    saved_count = 0
    
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
            
        frame_count += 1
        if frame_count % frame_interval != 0:
            continue
        
        timestamp = cap.get(cv2.CAP_PROP_POS_MSEC)
        frame_filename = os.path.join(FRAMES_DIR, f"frame_{int(timestamp)}s.jpg")
        success = cv2.imwrite(frame_filename, frame)
        # if not success:
        #     print(f"Failed to save frame {frame_filename}")
        # else:
        #     print(f"Saved {frame_filename}")
        saved_count += 1
        
    cap.release()
    print(f"Extracted {saved_count} frames to {FRAMES_DIR}")
    return saved_count

def format_timedelta(td: timedelta) -> str:
    """Convert timedelta to strict HH:MM:SS format with 2-digit hours."""
    total_seconds = int(td.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def write_to_csv(scenes):
    """Write scene data to CSV"""
    with open(OUTPUT_CSV, 'w', newline='') as csvfile:
        fieldnames = ['start_time', 'end_time', 'duration', 'class']
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        
        writer.writeheader()
        for scene in scenes:
            writer.writerow({
                'start_time': format_timedelta(timedelta(seconds=scene["start"])),
                'end_time': format_timedelta(timedelta(seconds=scene["end"])),
                'duration': format_timedelta(timedelta(seconds=scene["duration"])),
                'class': scene["class"]
            })

from concurrent.futures import ThreadPoolExecutor
import tqdm  # For progress bar (pip install tqdm if needed)

def process_frame(frame_file):
    """Process a single frame and return its data"""
    timestamp = float(frame_file.split("_")[1].replace("s.jpg", "")) / 1000.0
    frame_path = os.path.join(FRAMES_DIR, frame_file)
    image = Image.open(frame_path).convert("RGB")
    class_label, confidence = classify_image(image)
    return timestamp, class_label

def process_frames():
    """Process extracted frames in parallel to create classification log"""
    scenes = []
    current_class = None
    start_time = 0
    
    # Get all frame files sorted by timestamp
    frame_files = sorted(
        [f for f in os.listdir(FRAMES_DIR) if f.startswith("frame_") and f.endswith(".jpg")],
        key=lambda x: float(x.split("_")[1].replace("s.jpg", ""))
    )
    
    # Process frames in parallel
    print(f"Processing {len(frame_files)} frames with multithreading...")
    with ThreadPoolExecutor() as executor:
        # Use list() with tqdm to show progress bar
        results = list(tqdm.tqdm(executor.map(process_frame, frame_files), 
                      total=len(frame_files)))
    
    # Process results in order to detect scene changes
    for timestamp, class_label in results:
        if class_label != current_class:
            if current_class is not None:  # Save previous scene
                scenes.append({
                    "start": start_time,
                    "end": timestamp,
                    "duration": timestamp - start_time,
                    "class": current_class
                })
                print({
                    "start": start_time,
                    "end": format_timedelta(timedelta(seconds=timestamp)),
                    "duration": timestamp - start_time,
                    "class": current_class
                })
            current_class = class_label
            start_time = timestamp
        
        # Periodic save
        if len(scenes) % 20 == 0:
            write_to_csv(scenes)
    
    # Add the last scene
    if current_class is not None:
        scenes.append({
            "start": start_time,
            "end": timestamp,
            "duration": timestamp - start_time,
            "class": current_class
        })
    
    return scenes


if __name__ == "__main__":
    #print("Step 1: Extracting frames from video...")
    #extract_frames()
    
    print("\nStep 2: Processing frames to create classification log...")
    scenes = process_frames()
    write_to_csv(scenes)
    print(f"Done! Results saved to {OUTPUT_CSV}")