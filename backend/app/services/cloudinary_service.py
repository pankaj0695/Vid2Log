"""
DEPRECATED — superseded by app/services/gcs_service.py.

vid2log migrated off Cloudinary to Google Cloud Storage (via Firebase
Storage, so it reuses the same service account/credentials already
configured for Firestore) because Cloudinary's free plan caps raw-file
uploads at 10MB, which trained model files routinely exceed.

Nothing in the app imports this module anymore — see gcs_service.py for
the replacement (upload_file/download_blob/delete_blob/
find_stale_video_blobs), which every former caller of this file
(main.py, worker.py, routers/jobs.py, routers/models.py, routers/admin.py,
services/video_pipeline.py, services/training_pipeline.py, ml/classifier.py)
now uses instead.

This file is left in place (rather than deleted) only because the
migration was applied in a sandboxed environment that couldn't delete
files from the mounted project folder — it's safe to delete by hand once
you've confirmed the app runs correctly without it. If you still have the
`cloudinary` pip package installed, it's no longer required either (removed
from requirements.txt).
"""
