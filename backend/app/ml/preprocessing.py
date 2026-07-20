"""Shared image preprocessing for the CNN, used identically at training time
(app/services/training_pipeline.py) and inference time (app/ml/classifier.py)
so predictions are consistent between the two."""
from PIL import Image


def resize_with_padding(img: Image.Image, output_size=(224, 224), pad_color=(0, 0, 0)) -> Image.Image:
    original_width, original_height = img.size
    target_width, target_height = output_size
    scale = min(target_width / original_width, target_height / original_height)
    new_width = int(original_width * scale)
    new_height = int(original_height * scale)
    resized = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    padded = Image.new("RGB", (target_width, target_height), pad_color)
    x_offset = (target_width - new_width) // 2
    y_offset = (target_height - new_height) // 2
    padded.paste(resized, (x_offset, y_offset))
    return padded
