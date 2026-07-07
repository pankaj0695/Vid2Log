# Video Activity Classifier

A Streamlit web application that analyzes videos to classify and log different activities based on screen content. The application uses computer vision and machine learning to identify various activities like web browsing, coding, and more.

## Prerequisites

1. Python 3.8 or higher
2. Tesseract OCR installed on your system
   - Download and install from: https://github.com/UB-Mannheim/tesseract/wiki
   - Note the installation path as you'll need it for configuration

## Installation

1. Clone this repository
2. Install the required Python packages:
   ```
   pip install -r requirements.txt
   ```
3. Configure Tesseract path:
   - Open `video_processor.py`
   - Update the `pytesseract.pytesseract.tesseract_cmd` variable with your Tesseract installation path

## Directory Structure

- `app.py` - Main Streamlit application
- `video_processor.py` - Core video processing and classification logic
- `requirements.txt` - Python dependencies
- `new model/` - Contains the pre-trained models and labels
- `input_video/` - Directory for input videos (created automatically)
- `output/` - Directory for output CSV files (created automatically)

## Usage

1. Run the Streamlit app:
   ```
   streamlit run app.py
   ```
2. Open your web browser and navigate to the provided local URL (typically http://localhost:8501)
3. Upload a video file using the file uploader
4. Click "Process Video" to start the analysis
5. Once processing is complete, download the results as a CSV file

### Demo



https://github.com/user-attachments/assets/2afbbabc-394f-472d-8652-e09fc3c64771



## Features

- Supports multiple video formats (mp4, avi, mov, mkv)
- Real-time progress updates
- Preview of uploaded video
- Results displayed in an interactive table
- Downloadable CSV report

## Troubleshooting

- If you encounter Tesseract errors, ensure it's properly installed and the path in `video_processor.py` is correct
- For CUDA/GPU-related errors, you may need to install the appropriate version of TensorFlow that matches your system configuration
- Ensure all model files are present in the `new model/` directory

## Notes

- Processing time depends on video length and system performance
- For best results, use clear, high-quality video input
- The application processes 2 frames per second by default for a good balance between speed and accuracy
