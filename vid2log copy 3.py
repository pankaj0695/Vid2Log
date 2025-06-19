import tkinter as tk
from tkinter import messagebox
import pyautogui
import numpy as np
from keras.models import load_model
from PIL import Image, ImageOps
import time
import threading
import queue

# Load the pre-trained model
model = load_model("converted_keras/keras_model.h5", compile=False)
class_names = [line.strip() for line in open("converted_keras/labels.txt", "r").readlines()]

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
        image = ImageOps.fit(screenshot, (224, 224), Image.Resampling.LANCZOS)
        image_array = np.asarray(image)
        normalized_image_array = (image_array.astype(np.float32) / 127.5) - 1
        data = np.ndarray(shape=(1, 224, 224, 3), dtype=np.float32)
        data[0] = normalized_image_array
        
        prediction = model.predict(data)
        index = np.argmax(prediction)
        return class_names[index], prediction[0][index]

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