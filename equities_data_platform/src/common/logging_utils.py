"""Structured logging + audit-trail helpers shared by every ingestion/normalization job.

`RunLogger` wraps a single execution of a job in an `ingestion_runs` row and
routes every warning/error into `error_log`, so every pipeline run is fully
auditable from the database alone (no log-file spelunking required).
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from src.database.db import get_session
from src.database.models import ErrorLog, ErrorSeverity, IngestionRun, RunStatus

_LOG_DIR = Path(os.getenv("LOG_DIR", "data/logs"))


def get_logger(name: str) -> logging.Logger:
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger
    level = os.getenv("LOG_LEVEL", "INFO").upper()
    logger.setLevel(level)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")

    stream_handler = logging.StreamHandler(sys.stdout)
    stream_handler.setFormatter(fmt)
    logger.addHandler(stream_handler)

    try:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(_LOG_DIR / "platform.log")
        file_handler.setFormatter(fmt)
        logger.addHandler(file_handler)
    except OSError:
        pass  # logging to stdout only is fine if the filesystem is read-only

    return logger


class RunLogger:
    """Context manager that records an IngestionRun + any ErrorLog rows for one job execution.

    Usage:
        with RunLogger("daily_refresh", "sec_tickers") as run:
            run.record(processed=1, inserted=1)
            run.error("AAPL", "could not parse row")
    """

    def __init__(self, job_name: str, source: str):
        self.job_name = job_name
        self.source = source
        self.logger = get_logger(f"{job_name}.{source}")
        self.run_id: int | None = None
        self._processed = 0
        self._inserted = 0
        self._updated = 0
        self._error_count = 0
        self._notes: list[str] = []

    def __enter__(self) -> RunLogger:
        with get_session() as session:
            run = IngestionRun(job_name=self.job_name, source=self.source, status=RunStatus.RUNNING)
            session.add(run)
            session.flush()
            self.run_id = run.run_id
        self.logger.info("run started")
        return self

    def record(self, processed: int = 0, inserted: int = 0, updated: int = 0) -> None:
        self._processed += processed
        self._inserted += inserted
        self._updated += updated

    def error(self, entity_ref: str | None, message: str, severity: ErrorSeverity = ErrorSeverity.ERROR) -> None:
        self._error_count += 1
        self.logger.error("%s: %s", entity_ref, message)
        with get_session() as session:
            session.add(
                ErrorLog(
                    run_id=self.run_id,
                    source=self.source,
                    entity_ref=entity_ref,
                    severity=severity,
                    message=message,
                )
            )

    def note(self, text: str) -> None:
        self._notes.append(text)
        self.logger.info(text)

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        status = RunStatus.SUCCESS
        if exc_type is not None:
            status = RunStatus.FAILED
            self._notes.append(f"{exc_type.__name__}: {exc_val}")
        elif self._error_count > 0:
            status = RunStatus.PARTIAL

        with get_session() as session:
            run = session.get(IngestionRun, self.run_id)
            if run is not None:
                run.finished_at = _utcnow_local()
                run.status = status
                run.records_processed = self._processed
                run.records_inserted = self._inserted
                run.records_updated = self._updated
                run.error_count = self._error_count
                run.notes = "\n".join(self._notes) if self._notes else None

        self.logger.info(
            "run finished status=%s processed=%d inserted=%d updated=%d errors=%d",
            status.value, self._processed, self._inserted, self._updated, self._error_count,
        )
        return False  # never swallow exceptions


def _utcnow_local():
    import datetime as dt

    return dt.datetime.now(dt.timezone.utc)
