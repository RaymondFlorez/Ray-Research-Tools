"""Central path constants so every module agrees on where raw/processed/log data live."""
from __future__ import annotations

import datetime as dt
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
PROCESSED_DIR = DATA_DIR / "processed"
LOGS_DIR = DATA_DIR / "logs"


def raw_path(source: str, filename: str) -> Path:
    """Return (and ensure the parent directory of) a path under data/raw/<source>/<filename>."""
    directory = RAW_DIR / source
    directory.mkdir(parents=True, exist_ok=True)
    return directory / filename


def timestamped_filename(prefix: str, ext: str) -> str:
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}_{stamp}.{ext}"
