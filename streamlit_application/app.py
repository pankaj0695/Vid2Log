import os
import streamlit as st
import tempfile
import shutil
from datetime import timedelta
import time
from streamlit_application.video_processor import process_video, write_to_csv

# Set page config
st.set_page_config(
    page_title="Video Activity Classifier",
    page_icon="🎥",
    layout="wide"
)

def main():
    # Suppress TensorFlow warnings
    import warnings
    warnings.filterwarnings('ignore', category=DeprecationWarning)
    warnings.filterwarnings('ignore', category=FutureWarning)
    os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'  # Suppress TensorFlow info and warning messages
    
    st.title("🎥 Video Activity Classifier")
    st.write("Upload a video to analyze and classify activities")
    
    # Create necessary directories
    os.makedirs("temp_uploads", exist_ok=True)
    os.makedirs("output", exist_ok=True)
    
    # File uploader with no size limit
    uploaded_file = st.file_uploader(
        "Choose a video file", 
        type=["mp4", "avi", "mov", "mkv"],
        accept_multiple_files=False
    )
    
    if uploaded_file is not None:
        # Save uploaded file to temp location with chunked writing
        temp_dir = tempfile.mkdtemp()
        video_path = os.path.join(temp_dir, uploaded_file.name)
        
        # Use chunked writing to handle large files
        chunk_size = 1024 * 1024  # 1MB chunks
        with open(video_path, "wb") as f:
            while True:
                chunk = uploaded_file.read(chunk_size)
                if not chunk:
                    break
                f.write(chunk)
        
        # Show video preview (only for supported formats)
        try:
            st.video(video_path)
        except Exception as e:
            st.warning(f"Could not display video preview: {str(e)}")
            st.info("Video processing will continue, but preview is not available.")
        
        # Process button
        if st.button("Process Video"):
            progress_bar = st.progress(0)
            status_text = st.empty()
            
            try:
                # Initialize progress tracking
                status_text.text("Initializing video processing...")
                
                # Process the video with progress updates
                def progress_callback(current_frame, total_frames):
                    progress = int((current_frame / total_frames) * 100)
                    progress_bar.progress(progress)
                    status_text.text(f"Processing frame {current_frame} of {total_frames} ({progress}%)")
                
                # Process the video
                scenes = process_video(video_path, progress_callback=progress_callback)
                
                # Save results to CSV
                output_filename = f"output/{os.path.splitext(uploaded_file.name)[0]}_analysis.csv"
                write_to_csv(scenes, output_filename)
                
                # Update UI
                progress_bar.progress(100)
                status_text.text("Processing complete!")
                st.success("✅ Video processing complete!")
                
                # Show preview of results
                st.subheader("Analysis Results")
                st.dataframe(scenes)
                
                # Download button for results
                with open(output_filename, 'rb') as f:
                    st.download_button(
                        label="📥 Download Results (CSV)",
                        data=f,
                        file_name=os.path.basename(output_filename),
                        mime="text/csv"
                    )
                
            except Exception as e:
                import traceback
                st.error(f"An error occurred: {str(e)}")
                st.text(traceback.format_exc())
            finally:
                # Clean up temp files
                try:
                    shutil.rmtree(temp_dir, ignore_errors=True)
                except Exception as e:
                    st.warning(f"Warning: Could not clean up temporary files: {str(e)}")

if __name__ == "__main__":
    main()
