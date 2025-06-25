import pytesseract
from PIL import Image
pytesseract.pytesseract.tesseract_cmd = r'C:\Program Files\Tesseract-OCR\tesseract.exe'
image_path = r"classes\1 searching on the web\Arc_TYhwcWkMZi.png"
image_path = r"classes\9 preview output\vlc_bVIyMJoS4r.png"
full_img = Image.open(image_path)
width, height = full_img.size
address_bar_region = (0, 0, width, 150)  # (left, top, right, bottom)
cropped_img = full_img.crop(address_bar_region)
text = pytesseract.image_to_string(cropped_img)
print(text)
if('docs.google.com' in text):
    print("editing docs")
elif('google.com' in text):
    print("Browsing")
elif('File' in text and 'Edit' in text and 'Selection' in text and 'View' in text and 'Go' in text and 'Run' in text):
    print("VSC")
elif('github.com' in text):
    print("Github")
elif('localhost:' in text):
    print("preview output")