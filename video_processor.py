import os
import cv2
import csv
import numpy as np
from PIL import Image
import pytesseract
from keras.models import load_model
from datetime import timedelta
import shutil

# Configure Tesseract path (update this path according to your system)
pytesseract.pytesseract.tesseract_cmd = r'C:\\Program Files\\Tesseract-OCR\\tesseract.exe'

# Load models (update paths as needed)
MODEL_PATH = "new model/v2imp1_converted_keras_resized/keras_Model.h5"
LABELS_PATH = "new model/v2imp1_converted_keras_resized/labels.txt"
MODEL2_PATH = "new model/imp1_converted_keras_split/keras_model.h5"
LABELS2_PATH = "new model/imp1_converted_keras_split/labels.txt"

# Load models and class names
try:
    model = load_model(MODEL_PATH, compile=False)
    class_names = [line.strip() for line in open(LABELS_PATH, "r").readlines()]
    class_names.extend(["10 Class 11 code reference", "11 Class 12 socials", "12 Class 13 split window"])
    model2 = load_model(MODEL2_PATH, compile=False)
    class_names2 = [line.strip() for line in open(LABELS2_PATH, "r").readlines()]
except Exception as e:
    print(f"Error loading models: {e}")
    raise

def classify_addBar(full_img):
    """Classify image based on address bar content"""
    width, height = full_img.size
    address_bar_region = (0, 0, width, 250)
    cropped_img = full_img.crop(address_bar_region)
    text = pytesseract.image_to_string(cropped_img)
    
    if any(site in text.lower() for site in ['docs.google.com', 'docs.googlecom', 'docs. google.com', 'docs google.com']):
        return 4
    elif any(site in text.lower() for site in ['reddit.com', 'whatsapp.com', 'mail.google.com', 'mailgooglecom', 'mailgoogle.com']):
        return 11
    elif 'google.com' in text.lower():
        return 0
    elif all(term in text for term in ['File', 'Edit', 'Selection', 'View', 'Go', 'Run']):
        return 5
    elif 'github.com' in text.lower():
        return 2
    elif any(term in text.lower() for term in ['localhost:', 'localhost850', 'localhostss0', 'lbocalhost:', 'lbocalhost850']):
        return 8
    elif any(site in text.lower() for site in ['stackoverflow.com', 'geeksforgeeks.org', 'geeksforgeeks org', 'medium.com']):
        return 10
    return -1

def resize_with_padding(img, output_size=(224, 224), pad_color=(0, 0, 0)):
    """Resize image with padding to maintain aspect ratio"""
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
    """Classify the given image"""
    based_on_addbar = classify_addBar(image)
    image = resize_with_padding(image)
    image_array = np.asarray(image)
    normalized_image_array = (image_array.astype(np.float32) / 127.5) - 1
    data = np.expand_dims(normalized_image_array, axis=0)
    prediction = model.predict(data)
    
    prediction2 = model2.predict(data)
    if np.argmax(prediction2) == 1:
        return class_names[12], np.max(prediction2)

    if based_on_addbar > -1:
        return class_names[based_on_addbar], prediction[0][based_on_addbar] if based_on_addbar < 10 else 1.0
    else:
        return class_names[np.argmax(prediction)], np.max(prediction)

def process_video(video_path, fps=2, progress_callback=None):
    """Process video and return scene classifications
    
    Args:
        video_path (str): Path to the video file
        fps (int): Frames per second to process
        progress_callback (callable, optional): Function to report progress
            with signature (current_frame, total_frames)
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Could not open video file: {video_path}")
    
    # Get video properties
    video_fps = cap.get(cv2.CAP_PROP_FPS)
    frame_interval = int(video_fps // fps)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    # Calculate total frames to process (accounting for frame_interval)
    total_frames_to_process = (total_frames + frame_interval - 1) // frame_interval
    processed_frames = 0
    
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
            
        # Update progress
        processed_frames += 1
        if progress_callback and processed_frames % 5 == 0:  # Update every 5 frames to reduce overhead
            progress_callback(processed_frames, total_frames_to_process)
        
        # Process frame
        timestamp = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000  # Current time in seconds
        try:
            # Convert and process frame
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = Image.fromarray(frame_rgb).convert("RGB")
            
            # Classify image
            class_label, confidence = classify_image(image)
            
            # Manage memory
            del frame_rgb, frame
            
            # Handle scene change
            if class_label != current_class:
                if current_class is not None:  # Save previous scene
                    scenes.append({
                        "start": start_time,
                        "end": timestamp,
                        "duration": timestamp - start_time,
                        "class": current_class,
                        "confidence": confidence
                    })
                current_class = class_label
                start_time = timestamp
                
        except Exception as e:
            print(f"Error processing frame at {timestamp}s: {e}")
            continue
    
    # Add the last scene
    if current_class is not None:
        scenes.append({
            "start": start_time,
            "end": timestamp,
            "duration": timestamp - start_time,
            "class": current_class,
            "confidence": confidence
        })
    
    cap.release()
    return scenes

def format_timedelta(td_seconds):
    """Convert seconds to HH:MM:SS format"""
    td = timedelta(seconds=td_seconds)
    total_seconds = int(td.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"

def write_to_csv(scenes, output_path):
    """Write scene data to CSV"""
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
    
    with open(output_path, 'w', newline='') as csvfile:
        fieldnames = ['start_time', 'end_time', 'duration', 'class', 'confidence']
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        
        writer.writeheader()
        for scene in scenes:
            writer.writerow({
                'start_time': format_timedelta(scene["start"]),
                'end_time': format_timedelta(scene["end"]),
                'duration': format_timedelta(scene["duration"]),
                'class': scene["class"],
                'confidence': scene.get("confidence", 0.0)
            })
