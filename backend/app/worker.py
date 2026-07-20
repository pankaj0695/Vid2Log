"""
Run this as a separate process to actually execute queued jobs:

    python -m app.worker

Run more than one of these (more processes, or more containers/replicas) to
process more videos/training jobs in parallel — that's the whole mechanism
behind "process multiple videos simultaneously."
"""
import os
import sys

# macOS-only, and must run before anything else in this file. RQ normally
# forks a fresh "work-horse" child process for every job it runs. On macOS,
# if any Objective-C class in this process's dependency tree (grpc, Firebase
# Admin's networking, TensorFlow — all of which touch Apple's
# CoreFoundation/Security frameworks under the hood) was mid-initialization
# on another thread at that exact moment, the forked child crashes instead
# of continuing — visible as "objc[...]: +[__NSCFConstantString initialize]
# may have been in progress in another thread when fork() was called...
# Crashing instead", with RQ reporting "Work-horse terminated unexpectedly
# ... signal 6". `OBJC_DISABLE_INITIALIZE_FORK_SAFETY=YES` is Apple's own
# documented escape hatch for this — kept here as cheap defense-in-depth —
# but on newer macOS releases Apple hardened this abort so the env var
# doesn't reliably suppress it anymore (confirmed: it did NOT stop the crash
# above on this project's own dev machine, macOS with Python 3.11). The
# actual fix is below, in main(): use RQ's SimpleWorker on macOS, which
# executes jobs in this same process instead of forking a child at all —
# no fork() call means there's nothing for this Objective-C race to crash.
if sys.platform == "darwin":
    os.environ.setdefault("OBJC_DISABLE_INITIALIZE_FORK_SAFETY", "YES")

# Also unrelated to the above, but the same category of thing: grpc (used by
# google-cloud-firestore) bundles its own DNS resolver (c-ares) instead of
# using the OS's. On some home routers/ISPs that bundled resolver fails to
# resolve firestore.googleapis.com — with "Could not contact DNS servers" —
# even though the OS resolver (dig/nslookup/every other app) works fine.
# Forcing grpc to use the OS resolver instead fixes it. `setdefault` so it's
# still overridable via the environment if you've deliberately set this to
# something else.
os.environ.setdefault("GRPC_DNS_RESOLVER", "native")

# Also must run before TensorFlow is imported anywhere in this process (both
# training_pipeline.py's `import tensorflow as tf` and video_pipeline.py's
# `from app.ml.classifier import get_hybrid_classifier` — which pulls in
# `tf_keras` — are LAZY, resolved by RQ only once a job is actually
# dequeued, but that's still "anywhere in this process" once a job runs).
#
# TensorFlow >=2.16 bundles Keras 3 and makes `tf.keras` an alias for it by
# default. training_pipeline.py builds and saves models via plain
# `tf.keras.*`, so without this env var those saves land in Keras 3's H5
# format — whose InputLayer config uses a `batch_shape` key. But
# app/ml/classifier.py deliberately loads models via the separate `tf_keras`
# package (legacy Keras 2, kept for compatibility with older Teachable
# Machine exports), whose InputLayer doesn't recognize `batch_shape` at all
# and expects `batch_input_shape` instead — so every model this pipeline
# trained failed to load with "Unrecognized keyword arguments:
# ['batch_shape']" the moment a video job tried to use it. Setting this
# BEFORE tensorflow's own `__init__.py` runs (which is where this decision
# gets made and cached) makes `tf.keras` itself resolve to legacy Keras 2,
# so everything training_pipeline.py saves is readable by classifier.py's
# tf_keras-based loader again. Must be set here, at the very top of the
# worker process, rather than inside training_pipeline.py's lazy `import
# tensorflow` — a video job dequeued first in this same worker process would
# otherwise trigger tensorflow's real import (via tf_keras) before this env
# var ever got a chance to be set, locking in Keras 3 regardless.
os.environ.setdefault("TF_USE_LEGACY_KERAS", "1")

import logging

from redis import Redis
from rq import Worker
from rq.worker import SimpleWorker

from app.config import get_settings
from app.services import firebase_service, gcs_service

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

QUEUES = ["video_processing", "training"]

# See the big comment above. SimpleWorker runs each job in THIS process
# instead of forking a work-horse child for it — the tradeoff is that a
# genuinely crashing job (e.g. a segfault in some native library) can now
# take down the whole worker rather than just that one job's isolated
# child, but that's a much smaller risk in practice than "every single job
# has a chance of crashing on fork" was. Linux deployments don't have this
# bug at all, so they keep the normal forking Worker and its better
# per-job crash isolation.
WORKER_CLASS = SimpleWorker if sys.platform == "darwin" else Worker


def main() -> None:
    settings = get_settings()

    # Workers need the same external services configured as the API process.
    # Firebase (auth + Firestore) and Cloud Storage are independent of each
    # other now, so ordering between these two calls doesn't matter.
    firebase_service.init_firebase()
    gcs_service.configure()

    conn = Redis.from_url(settings.redis_url)
    worker = WORKER_CLASS(QUEUES, connection=conn)
    log.info("Worker listening on queues: %s (worker_class=%s)", QUEUES, WORKER_CLASS.__name__)
    worker.work(with_scheduler=False)


if __name__ == "__main__":
    main()
