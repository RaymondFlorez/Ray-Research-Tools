"""Engine/session management and a lightweight, dependency-free SQL migration runner.

We intentionally avoid Alembic to keep the platform's dependency footprint small
and the migration story transparent: every migration is a plain, numbered .sql
file in `migrations/`, applied in order and tracked in a `schema_migrations`
table so re-running `init_db()` is idempotent and safe for daily jobs to call.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path

import yaml
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from src.database.models import Base

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"


def resolve_database_url() -> str:
    """DATABASE_URL env var wins; otherwise fall back to config/database.yaml for APP_ENV."""
    env_url = os.getenv("DATABASE_URL")
    if env_url:
        return env_url

    app_env = os.getenv("APP_ENV", "local")
    config_path = PROJECT_ROOT / "config" / "database.yaml"
    with open(config_path) as fh:
        cfg = yaml.safe_load(fh)
    env_cfg = cfg.get(app_env, cfg["local"])
    if "url_env" in env_cfg:
        return os.getenv(env_cfg["url_env"], "sqlite:///data/processed/equities.db")
    return env_cfg["url"]


_engine = None
_SessionLocal: sessionmaker | None = None


def get_engine():
    global _engine
    if _engine is None:
        url = resolve_database_url()
        connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
        _engine = create_engine(url, connect_args=connect_args, future=True)
    return _engine


def get_session_factory() -> sessionmaker:
    global _SessionLocal
    if _SessionLocal is None:
        _SessionLocal = sessionmaker(bind=get_engine(), expire_on_commit=False, future=True)
    return _SessionLocal


@contextmanager
def get_session() -> Session:
    session = get_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


def _ensure_migrations_table(conn) -> None:
    conn.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version VARCHAR(64) PRIMARY KEY,
                applied_at TIMESTAMP
            )
            """
        )
    )


def applied_migrations(conn) -> set[str]:
    _ensure_migrations_table(conn)
    rows = conn.execute(text("SELECT version FROM schema_migrations")).fetchall()
    return {r[0] for r in rows}


def _strip_sql_comments(sql: str) -> str:
    """Strip '-- ...' line comments before naive statement splitting.

    Without this, a semicolon inside a comment (e.g. "...(`init_db()`);...")
    would fool a plain `sql.split(";")` into cutting a statement in half.
    """
    return "\n".join(line.split("--", 1)[0] for line in sql.splitlines())


def run_migrations() -> list[str]:
    """Apply any .sql files in migrations/ that haven't been applied yet, in filename order."""
    engine = get_engine()
    applied_now: list[str] = []
    with engine.begin() as conn:
        already = applied_migrations(conn)
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            version = path.stem
            if version in already:
                continue
            sql = _strip_sql_comments(path.read_text())
            for statement in filter(None, (s.strip() for s in sql.split(";"))):
                conn.execute(text(statement))
            conn.execute(
                text("INSERT INTO schema_migrations (version, applied_at) VALUES (:v, CURRENT_TIMESTAMP)"),
                {"v": version},
            )
            applied_now.append(version)
    return applied_now


def init_db(create_all: bool = True) -> None:
    """Create all tables from the ORM metadata, then apply any pending SQL migrations.

    Safe to call repeatedly (used by both `main.py init-db` and job entrypoints).
    """
    engine = get_engine()
    if create_all:
        Base.metadata.create_all(engine)
    run_migrations()
