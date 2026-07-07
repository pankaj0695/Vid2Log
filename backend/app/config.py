"""
Application settings, loaded from environment variables / .env.

Field names are lower_snake_case; pydantic-settings matches them to the
UPPER_SNAKE_CASE environment variables case-insensitively, so
`cloudinary_cloud_name` <-> `CLOUDINARY_CLOUD_NAME` needs no extra aliasing.
"""
from functools import lru_cache
from typing import List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Cloudinary
    cloudinary_upload_preset_name: str = ""
    cloudinary_cloud_name: str = ""
    cloudinary_api_key: str = ""
    cloudinary_api_secret: str = ""

    # Firebase (web config, mostly consumed by the frontend)
    firebase_api_key: str = ""
    firebase_auth_domain: str = ""
    firebase_project_id: str = ""
    firebase_storage_bucket: str = ""
    firebase_messaging_sender_id: str = ""
    firebase_app_id: str = ""
    firebase_measurement_id: str = ""

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
