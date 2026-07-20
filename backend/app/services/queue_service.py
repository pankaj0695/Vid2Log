"""
Redis + RQ job queue.

Redis is just the waiting room: FastAPI enqueues a lightweight job reference
(a job_id string, not the video itself), and one or more worker processes
(started separately via `python -m app.worker`) pick jobs up and run them.
This is what makes "process many videos in parallel" possible — run more
worker processes to increase throughput.
"""
import logging

import redis
from rq import Queue, Retry

from app.config import get_settings

log = logging.getLogger(__name__)

_redis_conn = None
_video_queue: Queue = None
_training_queue: Queue = None


def init_queues() -> None:
    global _redis_conn, _video_queue, _training_queue
    settings = get_settings()
    try:
        _redis_conn = redis.from_url(settings.redis_url)
        _redis_conn.ping()
        _video_queue = Queue("video_processing", connection=_redis_conn)
        _training_queue = Queue("training", connection=_redis_conn)
        log.info("Connected to Redis at %s", settings.redis_url)
    except Exception:
        log.warning(
            "Could not connect to Redis at %s — job enqueueing will fail "
            "until Redis is reachable.",
            settings.redis_url,
            exc_info=True,
        )
        _redis_conn = None
        _video_queue = None
        _training_queue = None


def get_video_queue() -> Queue:
    if _video_queue is None:
        raise RuntimeError("Redis/RQ is not configured (REDIS_URL unreachable).")
    return _video_queue


def get_training_queue() -> Queue:
    if _training_queue is None:
        raise RuntimeError("Redis/RQ is not configured (REDIS_URL unreachable).")
    return _training_queue


# Auto-retry a job a few times, with backoff, before giving up and leaving
# it for a human to hit "Retry" on. This exists for genuinely TRANSIENT
# failures — e.g. a brief DNS/network blip talking to Firestore — that have
# nothing to do with the job itself and would resolve on their own a few
# seconds later. It does NOT paper over real bugs (bad TF install, bad
# dataset): those fail the same way on every retry attempt and still end up
# recorded as "failed" in Firestore once retries are exhausted.
_TRANSIENT_RETRY = Retry(max=3, interval=[15, 60, 180])


def enqueue_video_job(job_id: str) -> None:
    # Enqueued by DOTTED STRING, not a direct function reference — this is
    # deliberate, not a style choice. video_pipeline.py imports app.ml.*,
    # which imports tf_keras/tensorflow at module load time. Passing the
    # actual `process_job` function here would require importing that whole
    # chain into the lightweight API process just to enqueue a job. RQ
    # resolves a string reference lazily, INSIDE the worker process, only
    # when it actually dequeues the job — so the API process never touches
    # TensorFlow at all, and a broken local TF install only ever breaks
    # in-progress training/processing, not the ability to submit jobs.
    get_video_queue().enqueue(
        "app.services.video_pipeline.process_job", job_id, job_timeout="30m", retry=_TRANSIENT_RETRY
    )


def enqueue_training_job(training_job_id: str) -> None:
    # Same reasoning as enqueue_video_job — training_pipeline.py imports
    # tensorflow directly, so this must stay a string reference.
    get_training_queue().enqueue(
        "app.services.training_pipeline.run_training_job",
        training_job_id,
        job_timeout="2h",
        retry=_TRANSIENT_RETRY,
    )
