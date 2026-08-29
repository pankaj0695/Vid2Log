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
_action_discovery_queue: Queue = None
_run_jobs_client = None


def init_queues() -> None:
    global _redis_conn, _video_queue, _training_queue, _action_discovery_queue
    settings = get_settings()
    try:
        _redis_conn = redis.from_url(settings.redis_url)
        _redis_conn.ping()
        _video_queue = Queue("video_processing", connection=_redis_conn)
        _training_queue = Queue("training", connection=_redis_conn)
        _action_discovery_queue = Queue("action_discovery", connection=_redis_conn)
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
        _action_discovery_queue = None


def get_video_queue() -> Queue:
    if _video_queue is None:
        raise RuntimeError("Redis/RQ is not configured (REDIS_URL unreachable).")
    return _video_queue


def get_training_queue() -> Queue:
    if _training_queue is None:
        raise RuntimeError("Redis/RQ is not configured (REDIS_URL unreachable).")
    return _training_queue


def get_action_discovery_queue() -> Queue:
    if _action_discovery_queue is None:
        raise RuntimeError("Redis/RQ is not configured (REDIS_URL unreachable).")
    return _action_discovery_queue


# Auto-retry a job a few times, with backoff, before giving up and leaving
# it for a human to hit "Retry" on. This exists for genuinely TRANSIENT
# failures — e.g. a brief DNS/network blip talking to Firestore — that have
# nothing to do with the job itself and would resolve on their own a few
# seconds later. It does NOT paper over real bugs (bad TF install, bad
# dataset): those fail the same way on every retry attempt and still end up
# recorded as "failed" in Firestore once retries are exhausted.
_TRANSIENT_RETRY = Retry(max=3, interval=[15, 60, 180])


def _trigger_worker_execution() -> None:
    """
    Fire a Cloud Run Job execution to drain the queues (`python -m
    app.worker --burst`), instead of relying on an always-on worker
    pool/replica that bills whether or not anything is queued.

    No-op locally: cloud_run_job_name is only set in production, so a
    developer running the API against a local Redis just runs
    `python -m app.worker` themselves in another terminal as before.

    Failures here are logged, not raised. The job is already durably sitting
    in Redis by the time this runs — a transient Cloud Run API hiccup
    shouldn't fail the request that enqueued it, and the next enqueue call
    (or `gcloud run jobs execute` by hand) will pick up anything left
    waiting regardless.
    """
    global _run_jobs_client
    settings = get_settings()
    if not settings.cloud_run_job_name:
        return
    try:
        from google.cloud import run_v2

        if _run_jobs_client is None:
            _run_jobs_client = run_v2.JobsClient()
        name = (
            f"projects/{settings.gcp_project_id}/locations/"
            f"{settings.cloud_run_region}/jobs/{settings.cloud_run_job_name}"
        )
        # Fire-and-forget: run_job() returns as soon as the execution is
        # accepted by Cloud Run — it does not block until the job finishes.
        # Running more than one execution concurrently is safe: RQ's BRPOP
        # dequeue is atomic, so two executions racing to drain the same
        # queues can't both pick up the same job.
        _run_jobs_client.run_job(name=name)
        log.info("Triggered Cloud Run Job execution: %s", settings.cloud_run_job_name)
    except Exception:
        log.warning(
            "Failed to trigger Cloud Run Job execution for %s — job stays "
            "queued in Redis for the next trigger.",
            settings.cloud_run_job_name,
            exc_info=True,
        )


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
    _trigger_worker_execution()


def enqueue_training_job(training_job_id: str) -> None:
    # Same reasoning as enqueue_video_job — training_pipeline.py imports
    # tensorflow directly, so this must stay a string reference.
    get_training_queue().enqueue(
        "app.services.training_pipeline.run_training_job",
        training_job_id,
        job_timeout="2h",
        retry=_TRANSIENT_RETRY,
    )
    _trigger_worker_execution()


def enqueue_action_discovery_job(job_id: str) -> None:
    # Same reasoning as enqueue_video_job/enqueue_training_job —
    # action_discovery_pipeline.py imports torch/transformers/hdbscan, so
    # this must stay a string reference too. 30m timeout mirrors the video
    # queue's — DINOv2 embedding is the dominant cost, same ballpark as a
    # video job's own CNN classification pass over similar frame counts.
    get_action_discovery_queue().enqueue(
        "app.services.action_discovery_pipeline.run_discovery_job",
        job_id,
        job_timeout="30m",
        retry=_TRANSIENT_RETRY,
    )
    _trigger_worker_execution()
