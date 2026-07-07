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
from rq import Queue

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


def enqueue_video_job(job_id: str) -> None:
    # Imported lazily to avoid a circular import (video_pipeline imports
    # services that are only needed once the job actually runs).
    from app.services.video_pipeline import process_job

    get_video_queue().enqueue(process_job, job_id, job_timeout="30m")


def enqueue_training_job(training_job_id: str) -> None:
    from app.services.training_pipeline import run_training_job

    get_training_queue().enqueue(run_training_job, training_job_id, job_timeout="2h")
