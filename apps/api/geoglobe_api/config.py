"""Typed application configuration (12-factor: env-driven)."""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GEOGLOBE_", env_file=".env", extra="ignore")

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

    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://localhost:4173",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:4173",
    ]


@lru_cache
def get_settings() -> Settings:
    return Settings()
