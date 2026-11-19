"""Forward-only SQL migration runner (Step 12).

Applies `NNN_name.sql` files from the migrations directory in filename order, recording
each in `schema_migrations` (filename + SHA-256) inside the same transaction as the
migration itself. Re-running is a no-op; editing an already-applied file is refused, so
history can't silently diverge between environments. The base migrations are idempotent
(IF NOT EXISTS), so this is also safe on a database the Postgres image initialized from
the same files via /docker-entrypoint-initdb.d.

Usage:
    GEOGLOBE_DATABASE_URL=postgresql+psycopg://... python -m geoglobe_api.migrate [--dry-run]
See docs/runbooks/database-migrations.md.
"""

from __future__ import annotations

import argparse
import hashlib
from dataclasses import dataclass
from pathlib import Path

from .config import get_settings

_IMAGE_DIR = Path("/app/migrations")
_LOCK_KEY = 0x6E06_10BE  # arbitrary, stable advisory-lock id for this app


@dataclass(frozen=True)
class Migration:
    name: str
    sql: str

    @property
    def checksum(self) -> str:
        return hashlib.sha256(self.sql.encode()).hexdigest()


class MigrationError(RuntimeError):
    pass


def migrations_dir() -> Path:
    configured = get_settings().migrations_dir
    if configured:
        return Path(configured)
    if _IMAGE_DIR.is_dir():
        return _IMAGE_DIR
    # In a checkout: apps/api/geoglobe_api/migrate.py → <repo>/infra/db/init.
    parents = Path(__file__).resolve().parents
    if len(parents) > 3:
        return parents[3] / "infra" / "db" / "init"
    raise MigrationError("no migrations directory found; set GEOGLOBE_MIGRATIONS_DIR")


def load_migrations(directory: Path) -> list[Migration]:
    if not directory.is_dir():
        raise MigrationError(f"migrations directory not found: {directory}")
    return [Migration(p.name, p.read_text()) for p in sorted(directory.glob("*.sql"))]


def pending(migrations: list[Migration], applied: dict[str, str]) -> list[Migration]:
    """Migrations not yet applied. Raises if an applied file's contents changed."""
    for m in migrations:
        if m.name in applied and applied[m.name] != m.checksum:
            raise MigrationError(
                f"{m.name} was modified after being applied; add a new migration instead"
            )
    return [m for m in migrations if m.name not in applied]


def run(dry_run: bool = False) -> list[str]:  # pragma: no cover - needs Postgres
    from sqlalchemy import create_engine, text

    settings = get_settings()
    if not settings.database_url:
        raise SystemExit("GEOGLOBE_DATABASE_URL must be set to run migrations")
    engine = create_engine(settings.database_url)
    migrations = load_migrations(migrations_dir())

    # A session-level advisory lock serializes concurrent runners (e.g. an init container
    # in every API replica): the first applies, the rest wait and then find nothing to do.
    # Everything — even creating the bookkeeping table — happens under the lock, since
    # concurrent CREATE TABLE IF NOT EXISTS can itself race in Postgres.
    with engine.connect() as lock_conn:
        lock_conn.execute(text("SELECT pg_advisory_lock(:k)"), {"k": _LOCK_KEY})
        try:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        "CREATE TABLE IF NOT EXISTS schema_migrations ("
                        " name TEXT PRIMARY KEY, checksum TEXT NOT NULL,"
                        " applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
                    )
                )
                applied = dict(
                    conn.execute(text("SELECT name, checksum FROM schema_migrations")).all()
                )
            todo = pending(migrations, applied)
            for m in todo if not dry_run else []:
                # One transaction per migration: DDL and bookkeeping commit together.
                with engine.begin() as conn:
                    conn.exec_driver_sql(m.sql)
                    conn.execute(
                        text("INSERT INTO schema_migrations (name, checksum) VALUES (:n, :c)"),
                        {"n": m.name, "c": m.checksum},
                    )
        finally:
            lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _LOCK_KEY})
            lock_conn.commit()
    return [m.name for m in todo]


def main() -> None:  # pragma: no cover
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="list pending, apply nothing")
    args = parser.parse_args()
    names = run(dry_run=args.dry_run)
    verb = "Pending" if args.dry_run else "Applied"
    print(f"{verb}: {', '.join(names) if names else 'nothing — schema is up to date'}")


if __name__ == "__main__":  # pragma: no cover
    main()
