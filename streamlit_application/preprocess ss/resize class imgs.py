import os
from PIL import Image

def resize_with_padding(img, target_size=(224, 224), pad_color=(0, 0, 0)):
    original_width, original_height = img.size
    target_width, target_height = target_size
    
    # Calculate scaling factor
    scale = min(target_width / original_width, target_height / original_height)
    new_width = int(original_width * scale)
    new_height = int(original_height * scale)
    
    # Resize the image
    img = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
    
    # Create a new padded image
    padded_img = Image.new("RGB", target_size, pad_color)
    x_offset = (target_width - new_width) // 2
    y_offset = (target_height - new_height) // 2
    padded_img.paste(img, (x_offset, y_offset))
    
    return padded_img

# Paths
input_root = "classes"  # Original folder
output_root = "classes_new"  # New folder

# Process all images
for class_dir in os.listdir(input_root):
    class_path = os.path.join(input_root, class_dir)
    if os.path.isdir(class_path):
        # Create corresponding output directory
        output_class_dir = os.path.join(output_root, class_dir)
        os.makedirs(output_class_dir, exist_ok=True)
        
        # Resize each image in the class folder
        for img_name in os.listdir(class_path):
            if img_name.lower().endswith(('.png', '.jpg', '.jpeg')):
                img_path = os.path.join(class_path, img_name)
                img = Image.open(img_path)
                resized_img = resize_with_padding(img)
                resized_img.save(os.path.join(output_class_dir, img_name))

print("All images resized and saved to 'classes_new' with the same structure!")