import tkinter as tk
from tkinter import messagebox
import pyautogui
import numpy as np
from keras.models import load_model
from PIL import Image, ImageOps
import time
import threading
import queue

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
    address_bar_region = (0, 0, width, 150)  # (left, top, right, bottom)
    cropped_img = full_img.crop(address_bar_region)
    text = pytesseract.image_to_string(cropped_img)
    print(text) if "vid2log" not in text else ()
    if('docs.google.com' in text or 'docs.googlecom' in text):
        return (4)
    elif('reddit.com' in text or 'whatsapp.com' in text or 'mail.google.com' in text or 'mailgooglecom' in text ):
        return (11)
    elif('google.com' in text):
        return (0)
    elif('File' in text and 'Edit' in text and 'Selection' in text and 'View' in text and 'Go' in text and 'Run' in text):
        return (5)
    elif('github.com' in text):
        return (2)
    elif('localhost:' in text):
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


# Configuration
UPDATE_INTERVAL = 2.0  # Seconds between classifications
TOOLTIP_DURATION = 2000  # Milliseconds to display tooltip

class ScreenClassifier:
    def __init__(self):
        self.root = tk.Tk()
        self.root.withdraw()  # Hide main window
        self.message_queue = queue.Queue()
        self.last_class = ""
        self.running = True
        self.tooltip = None
        
    def show_tooltip(self, message):
        """Show a temporary tooltip message (called from main thread)"""
        if self.tooltip:
            self.tooltip.destroy()
            
        self.tooltip = tk.Toplevel()
        self.tooltip.wm_overrideredirect(True)
        self.tooltip.wm_geometry("+50+50")
        label = tk.Label(self.tooltip, text=message, bg="yellow", padx=10, pady=5)
        label.pack()
        self.tooltip.after(TOOLTIP_DURATION, self.tooltip.destroy)

    def process_queue(self):
        """Check for messages from background thread"""
        try:
            message = self.message_queue.get_nowait()
            self.show_tooltip(message)
        except queue.Empty:
            pass
        self.root.after(100, self.process_queue)  # Check every 100ms

    def classify_screen(self):
        """Capture and classify screen content"""
        screenshot = pyautogui.screenshot()
        return classify_image(screenshot)

    def run_classification(self):
        """Background classification loop"""
        while self.running:
            class_name, confidence = self.classify_screen()
            display_text = f"{class_name} ({confidence*100:.1f}%)"
            
            
            self.message_queue.put(display_text)
            self.last_class = class_name
            
            time.sleep(UPDATE_INTERVAL)

    def start(self):
        """Start classification"""
        # Start background classification thread
        self.classification_thread = threading.Thread(target=self.run_classification, daemon=True)
        self.classification_thread.start()
        
        # Start processing the message queue in main thread
        self.process_queue()
        
        # Start the Tkinter main loop
        self.root.mainloop()

    def stop(self):
        """Stop classification"""
        self.running = False
        self.root.quit()

if __name__ == "__main__":
    classifier = ScreenClassifier()
    
    try:
        classifier.start()
    except KeyboardInterrupt:
        classifier.stop()