"""
Run this as a separate process to actually execute queued jobs:

    python -m app.worker

Run more than one of these (more processes, or more containers/replicas) to
process more videos/training jobs in parallel — that's the whole mechanism
behind "process multiple videos simultaneously."
"""
import logging

from redis import Redis
from rq import Worker

from app.config import get_settings
from app.services import cloudinary_service, firebase_service

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

QUEUES = ["video_processing", "training"]


def main() -> None:
    settings = get_settings()

    # Workers need the same external services configured as the API process.
    cloudinary_service.configure()
    firebase_service.init_firebase()

    conn = Redis.from_url(settings.redis_url)
    worker = Worker(QUEUES, connection=conn)
    log.info("Worker listening on queues: %s", QUEUES)
    worker.work(with_scheduler=False)


if __name__ == "__main__":
    main()
