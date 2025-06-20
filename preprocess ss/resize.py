import cv2
import numpy as np
from PIL import Image
import os

def resize_with_padding(img_path, output_size=(224, 224), pad_color=(0, 0, 0)):
    img = Image.open(img_path)
    original_width, original_height = img.size
    target_width, target_height = output_size
    
    # Calculate the scaling factor
    scale = min(target_width / original_width, target_height / original_height)
    new_width = int(original_width * scale)
    new_height = int(original_height * scale)
    
    # Resize the image while maintaining aspect ratio
    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    
    # Create a new blank image of the target size
    padded_img = Image.new("RGB", (target_width, target_height), pad_color)
    
    # Calculate padding positions (centered)
    x_offset = (target_width - new_width) // 2
    y_offset = (target_height - new_height) // 2
    
    # Paste the resized image onto the padded canvas
    padded_img.paste(img, (x_offset, y_offset))
    
    return padded_img

# Example usage
input_folder = "./input_frames"  # Folder containing screenshots
output_folder = "output_images"  # Folder to save resized images

os.makedirs(output_folder, exist_ok=True)

for filename in os.listdir(input_folder):
    if filename.lower().endswith(('.png', '.jpg', '.jpeg')):
        img_path = os.path.join(input_folder, filename)
        resized_img = resize_with_padding(img_path)
        resized_img.save(os.path.join(output_folder, filename))

print("All images resized and padded to 224x224!")