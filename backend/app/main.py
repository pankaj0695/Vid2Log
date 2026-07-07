import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import admin, analytics, jobs, logs, models, train
from app.services import cloudinary_service, firebase_service, queue_service

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup — configure the three external services once per process.
    cloudinary_service.configure()
    firebase_service.init_firebase()
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


@app.get("/config/cloudinary")
def cloudinary_config():
    """Safe-to-expose config the frontend needs for its unsigned upload
    widget (cloud_name + preset name only — no API secret)."""
    return cloudinary_service.get_unsigned_upload_config()
