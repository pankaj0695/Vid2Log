from keras.models import load_model  # TensorFlow is required for Keras to work
from PIL import Image, ImageOps  # Install pillow instead of PIL
import numpy as np

# Disable scientific notation for clarity
np.set_printoptions(suppress=True)

# Load the model
model = load_model("converted_keras2/keras_Model.h5", compile=False)

# Load the labels
class_names = open("converted_keras2/labels.txt", "r").readlines()

def classify_image(image):
    image = ImageOps.fit(image, (224, 224), Image.Resampling.LANCZOS)
    image_array = np.asarray(image)
    normalized_image_array = (image_array.astype(np.float32) / 127.5) - 1
    data = np.expand_dims(normalized_image_array, axis=0)
    prediction = model.predict(data)
    return class_names[np.argmax(prediction)], np.max(prediction)

# Replace this with the path to your image
image = Image.open(r"classes\11 split screen\9Zm6VBoGiW.png").convert("RGB")

class_name, confidence_score = classify_image(image)

# Print prediction and confidence score
print("Class:", class_name)
print("Confidence Score:", confidence_score)