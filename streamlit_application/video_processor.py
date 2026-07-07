import os
import csv
import logging
import time
import cv2
import numpy as np
from PIL import Image
from tf_keras.models import load_model
from tf_keras.layers import DepthwiseConv2D
from datetime import timedelta

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


class _DepthwiseConv2DCompat(DepthwiseConv2D):
    def __init__(self, *args, **kwargs):
        kwargs.pop('groups', None)
        super().__init__(*args, **kwargs)


_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(_BASE_DIR, "new_model", "game_keras", "keras_model.h5")
LABELS_PATH = os.path.join(_BASE_DIR, "new_model", "game_keras", "labels.txt")

log.info("Loading model from %s", MODEL_PATH)
try:
    model = load_model(MODEL_PATH, compile=False,
                       custom_objects={'DepthwiseConv2D': _DepthwiseConv2DCompat})
    class_names = [line.strip() for line in open(LABELS_PATH, "r").readlines()]
    log.info("Model loaded successfully. Classes: %s", class_names)
except Exception as e:
    log.error("Error loading model: %s", e)
    model = None
    class_names = []


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
    image = resize_with_padding(image)
    image_array = np.asarray(image)
    normalized_image_array = (image_array.astype(np.float32) / 127.5) - 1
    data = np.expand_dims(normalized_image_array, axis=0)
    # Use direct call instead of predict() to avoid per-frame overhead/progress bar
    prediction = model(data, training=False).numpy()
    return class_names[np.argmax(prediction)], float(np.max(prediction))


def process_video(video_path, fps=2, progress_callback=None):
    log.info("Opening video: %s", video_path)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise ValueError(f"Could not open video file: {video_path}")

    video_fps = cap.get(cv2.CAP_PROP_FPS)
    frame_interval = max(1, int(video_fps // fps))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = total_frames / video_fps if video_fps > 0 else 0
    total_frames_to_process = (total_frames + frame_interval - 1) // frame_interval

    log.info(
        "Video info — fps: %.2f, total frames: %d, duration: %.1fs, "
        "processing every %d frames (~%d frames to classify)",
        video_fps, total_frames, duration_sec, frame_interval, total_frames_to_process,
    )

    scenes = []
    current_class = None
    start_time = 0
    frame_count = 0
    processed_frames = 0
    last_class = None
    t_start = time.time()

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        frame_count += 1
        if frame_count % frame_interval != 0:
            continue

        processed_frames += 1
        timestamp = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000

        if progress_callback and processed_frames % 5 == 0:
            progress_callback(processed_frames, total_frames_to_process)

        try:
            frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            image = Image.fromarray(frame_rgb).convert("RGB")
            del frame_rgb, frame

            t0 = time.time()
            class_label, confidence = classify_image(image)
            elapsed = time.time() - t0

            print(
                f"\r{time.strftime('%H:%M:%S')} [INFO]"
                f" [{processed_frames}/{total_frames_to_process}]"
                f" t={timestamp:.2f}s | {class_label:<30} conf={confidence:.3f}"
                f" | infer={elapsed:.2f}s",
                end="", flush=True,
            )

            if class_label != current_class:
                if current_class is not None:
                    print()  # end the in-place line before scene-change message
                    log.info(
                        "  Scene change: '%s' -> '%s' (was %.1fs long)",
                        current_class, class_label, timestamp - start_time,
                    )
                    scenes.append({
                        "start": start_time,
                        "end": timestamp,
                        "duration": timestamp - start_time,
                        "class": current_class,
                        "confidence": confidence,
                    })
                current_class = class_label
                start_time = timestamp

        except Exception as e:
            log.error("Error at t=%.2fs: %s", timestamp, e)
            continue

    if current_class is not None:
        scenes.append({
            "start": start_time,
            "end": timestamp,
            "duration": timestamp - start_time,
            "class": current_class,
            "confidence": confidence,
        })

    cap.release()
    total_time = time.time() - t_start
    print()  # end the in-place progress line
    log.info(
        "Done. Processed %d frames in %.1fs (%.2f frames/sec). %d scenes found.",
        processed_frames, total_time,
        processed_frames / total_time if total_time > 0 else 0,
        len(scenes),
    )
    return scenes


def format_timedelta(td_seconds):
    td = timedelta(seconds=td_seconds)
    total_seconds = int(td.total_seconds())
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def write_to_csv(scenes, output_path):
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
                'confidence': scene.get("confidence", 0.0),
            })
