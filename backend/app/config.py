"""
Application settings, loaded from environment variables / .env.

Field names are lower_snake_case; pydantic-settings matches them to the
UPPER_SNAKE_CASE environment variables case-insensitively, so
`firebase_project_id` <-> `FIREBASE_PROJECT_ID` needs no extra aliasing.
"""
from functools import lru_cache
from typing import List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Firebase (web config consumed by the frontend for Auth; the backend
    # itself only reads firebase_project_id, to initialize Firebase Admin
    # for token verification + Firestore — see firebase_service.py). Storage
    # is a SEPARATE, standalone GCS bucket (see gcs_bucket_name below), not
    # Firebase-managed, since Firebase Storage requires the Blaze billing
    # plan whereas a plain GCS bucket does not.
    firebase_api_key: str = ""
    firebase_auth_domain: str = ""
    firebase_project_id: str = ""
    firebase_storage_bucket: str = ""
    firebase_messaging_sender_id: str = ""
    firebase_app_id: str = ""
    firebase_measurement_id: str = ""

    # Standalone Google Cloud Storage bucket (NOT Firebase Storage) — used
    # for video/training-image uploads and durable model-file storage. See
    # app/services/gcs_service.py and backend/README.md → "Cloud Storage
    # setup" for how to create the bucket and grant IAM access.
    gcs_bucket_name: str = ""

    # Backend-only additions
    google_application_credentials: Optional[str] = None
    redis_url: str = "redis://localhost:6379/0"
    cors_origins: str = "http://localhost:3000"
    app_env: str = "development"

    @property
    def cors_origin_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
