import os

# Must run before anything below imports google-cloud-firestore/grpc. grpc
# bundles its own DNS resolver (c-ares) instead of using the OS's, and that
# bundled resolver fails to resolve firestore.googleapis.com on some home
# routers/ISPs ("Could not contact DNS servers") even though the OS
# resolver (dig/nslookup/every other app) works fine. This forces grpc to
# use the OS resolver instead — see the identical, more detailed comment in
# app/worker.py, where this same problem first showed up in practice.
os.environ.setdefault("GRPC_DNS_RESOLVER", "native")

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.routers import admin, analytics, jobs, logs, models, train, uploads, users
from app.services import firebase_service, gcs_service, queue_service

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup — configure the three external services once per process.
    # Firebase (auth + Firestore) and Cloud Storage are fully independent of
    # each other now (gcs_service uses its own google.cloud.storage.Client),
    # so ordering between these two calls doesn't matter.
    firebase_service.init_firebase()
    gcs_service.configure()
    queue_service.init_queues()
    log.info("vid2log API started (env=%s).", get_settings().app_env)
    yield
    # Shutdown — nothing to release explicitly (Redis/Firestore clients are
    # process-lifetime and closed by the OS on exit).
    log.info("vid2log API shutting down.")


app = FastAPI(title="vid2log API", version="0.1.0", lifespan=lifespan)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """
    Without this, an unhandled exception (e.g. a raw Firestore error) is
    caught by Starlette's ServerErrorMiddleware, which sits OUTSIDE our
    CORSMiddleware and returns a plain response with no CORS headers at all.
    The browser then reports a "blocked by CORS policy" error, which is
    misleading — the real problem is always a server-side 500. Registering a
    handler here keeps the response inside CORSMiddleware's territory (so
    the frontend gets a normal, readable error) and logs the full traceback
    server-side so the actual cause is easy to find.
    """
    log.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal server error — check server logs."})


app.include_router(users.router)
app.include_router(uploads.router)
app.include_router(jobs.router)
app.include_router(logs.router)
app.include_router(models.router)
app.include_router(train.router)
app.include_router(analytics.router)
app.include_router(admin.router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "firebase_configured": firebase_service.is_configured(),
    }
