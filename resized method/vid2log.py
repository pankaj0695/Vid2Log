from keras.models import load_model  # TensorFlow is required for Keras to work
from PIL import Image, ImageOps  # Install pillow instead of PIL
import numpy as np

# Disable scientific notation for clarity
np.set_printoptions(suppress=True)

# Load the model
model = load_model("new model/converted_keras_resized2/keras_Model.h5", compile=False)

# Load the labels
class_names = open("new model/converted_keras_resized2/labels.txt", "r").readlines()

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
    prediction = model.predict(data)
    return class_names[np.argmax(prediction)], np.max(prediction)

# Replace this with the path to your image
image = Image.open(r"classes\2 reading technical documentation\Arc_on23bNXYh4.png").convert("RGB")

class_name, confidence_score = classify_image(image)

# Print prediction and confidence score
print("Class:", class_name)
print("Confidence Score:", confidence_score)