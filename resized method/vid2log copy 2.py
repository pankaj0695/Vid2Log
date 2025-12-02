import os
import csv
import cv2
import numpy as np
from keras.models import load_model
from PIL import Image, ImageOps
from datetime import timedelta

analyze= -1 #4*3600+37*60+55

# Configuration
INPUT_VIDEO = "input_video/3/2025-02-02 09-54-26p.mkv"  # Relative path to your video
FPS = 2  # Frames to process per second
OUTPUT_CSV = "scenes/v1_scene_classification_3__________pratiksha.csv"

# Load model
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
    #if analyze>-1:
        #print(text) if "vid2log" not in text else ()
    if('docs.google.com' in text or 'docs.googlecom' in text or 'docs. google.com' in text or 'docs google.com' in text):
        return (4)
    elif('reddit.com' in text or 'whatsapp.com' in text or 'mail.google.com' in text or 'mailgooglecom' in text or 'mailgoogle.com' in text):
        return (11)
    elif('google.com' in text):
        return (0)
    elif('File' in text and 'Edit' in text and 'Selection' in text and 'View' in text and 'Go' in text and 'Run' in text):
        return (5)
    elif('github.com' in text):
        return (2)
    elif('localhost:' in text or 'localhost850' in text or 'localhostss0' in text or 'lbocalhost:' in text or 'lbocalhost850' in text):
        return (8)
    elif('stackoverflow.com' in text or 'geeksforgeeks.org' in text or 'geeksforgeeks org' in text or 'medium.com' in text):
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

def process_video():
    """Main processing function"""
    cap = cv2.VideoCapture(INPUT_VIDEO)
    video_fps = cap.get(cv2.CAP_PROP_FPS)
    frame_interval = int(video_fps // FPS)
    
    scenes = []
    current_class = None
    start_time = 0
    frame_count = 0
    if analyze>-1:
        cap.set(cv2.CAP_PROP_POS_MSEC, analyze * 1000)
    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break
        
        frame_count += 1
        if frame_count % frame_interval != 0:
            continue
        
        # if analyze>-1:
        #     if cap.get(cv2.CAP_PROP_POS_MSEC) / 1000>analyze+20:
        #         break
        
        timestamp = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000  # Current time in seconds
        if analyze>-1:
            print((timedelta(seconds=timestamp)))
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = Image.fromarray(frame_rgb).convert("RGB")
        class_label, confidence = classify_image(image)
        if analyze>-1:
            print(class_label,confidence)
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
        if (len(scenes))%20==0:
            write_to_csv(scenes)
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

if __name__ == "__main__":
    print("Processing video...")
    scenes = process_video()
    write_to_csv(scenes)
    print(f"Done! Results saved to {OUTPUT_CSV}")