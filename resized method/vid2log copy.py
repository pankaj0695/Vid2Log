import os
import shutil
from keras.models import load_model
from PIL import Image, ImageOps
import numpy as np

# Disable scientific notation
np.set_printoptions(suppress=True)

# Load model and labels
model = load_model("converted_keras2/keras_Model.h5", compile=False)
class_names = [line.strip() for line in open("converted_keras2/labels.txt", "r").readlines()]

def classify_image(image):
    image = ImageOps.fit(image, (224, 224), Image.Resampling.LANCZOS)
    image_array = np.asarray(image)
    normalized_image_array = (image_array.astype(np.float32) / 127.5) - 1
    data = np.expand_dims(normalized_image_array, axis=0)
    prediction = model.predict(data)
    return class_names[np.argmax(prediction)], np.max(prediction)

# Paths
input_folder = "input_frames"
output_root = "classified_output"

# Create output directory (clear if exists)
if os.path.exists(output_root):
    shutil.rmtree(output_root)
os.makedirs(output_root)

# Create subfolders for each class
for class_name in class_names:
    class_folder = os.path.join(output_root, class_name)  # Use only the class name (e.g., "chrome")
    os.makedirs(class_folder, exist_ok=True)

# Process each image
for filename in os.listdir(input_folder):
    if filename.lower().endswith(('.png', '.jpg', '.jpeg')):
        image_path = os.path.join(input_folder, filename)
        
        try:
            # Preprocess image
            image = Image.open(image_path).convert("RGB")
            
            predicted_class,confidence = classify_image(image)

            # Move image to class folder
            dest_folder = os.path.join(output_root, predicted_class)
            shutil.copy2(image_path, dest_folder)  # Use copy2 to preserve metadata

            print(f"{filename} → {predicted_class} (Confidence: {confidence:.2f})")

        except Exception as e:
            print(f"Error processing {filename}: {str(e)}")

print(f"\nClassification complete! Images organized in '{output_root}' folder.")