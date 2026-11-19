"""Typed application configuration (12-factor: env-driven)."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

VERSION = "0.1.0"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GEOGLOBE_", env_file=".env", extra="ignore")

    # "production" turns misconfigurations that are merely risky in dev into startup
    # errors (see _check_production). Every field below maps to GEOGLOBE_<NAME>.
    environment: Literal["development", "production"] = "development"

    # When unset, the app runs against the in-memory repository (dev/tests, no DB needed).
    # In production this is e.g. postgresql+psycopg://geoglobe:geoglobe@db:5432/geoglobe
    database_url: str | None = None

    # Guardrails for query endpoints (enforced regardless of repository).
    max_rows: int = 5000
    statement_timeout_ms: int = 5000

    # LLM agent (Step 7). API key resolved by the Anthropic SDK if unset here.
    anthropic_api_key: str | None = None
    agent_planner_model: str = "claude-opus-4-8"
    agent_fast_model: str = "claude-sonnet-4-6"
    agent_max_turns: int = 12
    # "demo" swaps in a deterministic, key-free LLM (smoke tests, offline demos).
    agent_llm: Literal["anthropic", "demo"] = "anthropic"

    # Auth (Step 10). Off by default for dev; enable + set a secret in production.
    auth_required: bool = False
    jwt_secret: str | None = None
    jwt_audience: str | None = None

    # Observability (Step 10).
    trace_buffer_size: int = 200

    # Caching (Step 11). Unset → per-process in-memory TTL cache.
    redis_url: str | None = None
    query_cache_ttl_s: int = 300

    # Migrations (Step 12). Unset → /app/migrations in the image, infra/db/init in a checkout.
    migrations_dir: str | None = None

    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:4173",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:4173",
    ]

    @field_validator(
        "database_url",
        "anthropic_api_key",
        "jwt_secret",
        "jwt_audience",
        "redis_url",
        "migrations_dir",
        mode="before",
    )
    @classmethod
    def _blank_is_unset(cls, value: object) -> object:
        # `GEOGLOBE_JWT_SECRET=` in an env file means "not set", not "empty secret".
        return None if isinstance(value, str) and not value.strip() else value

    @model_validator(mode="after")
    def _check_production(self) -> "Settings":
        problems: list[str] = []
        if self.auth_required and not self.jwt_secret:
            problems.append("GEOGLOBE_AUTH_REQUIRED=true needs GEOGLOBE_JWT_SECRET")
        if self.environment == "production":
            if not self.database_url:
                problems.append("GEOGLOBE_DATABASE_URL is required in production")
            if self.jwt_secret is not None and len(self.jwt_secret) < 32:
                problems.append(
                    "GEOGLOBE_JWT_SECRET must be at least 32 characters "
                    "(generate one with: openssl rand -hex 32)"
                )
        if problems:
            raise ValueError("Invalid configuration: " + "; ".join(problems))
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
