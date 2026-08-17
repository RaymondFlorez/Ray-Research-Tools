"""Ingest daily OHLCV history from Stooq's free CSV endpoint.

Stooq (https://stooq.com) publishes free daily-bar CSVs with no API key and no
authentication for personal/research use. This is the platform's primary price
source; Yahoo is only used as an explicitly-labeled fallback (see
yahoo_fallback.py) when Stooq has no data for a symbol.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
from dataclasses import dataclass

import yaml

from src.common.http import HttpClient
from src.common.paths import PROJECT_ROOT, raw_path, timestamped_filename
from src.normalization.identifiers import normalize_ticker

_SOURCE = "stooq"

# Stooq returns this exact body (no header row) when a symbol has no data.
_NO_DATA_MARKER = "No data"


@dataclass
class PriceBar:
    ticker: str
    trade_date: dt.date
    open: float | None
    high: float | None
    low: float | None
    close: float | None
    volume: int | None
    adj_close: float | None = None


def _load_config() -> dict:
    with open(PROJECT_ROOT / "config" / "sources.yaml") as fh:
        return yaml.safe_load(fh)["stooq"]


def _client() -> HttpClient:
    cfg = _load_config()
    return HttpClient(user_agent="equities-data-platform (open-source, free-data pipeline)",
                       requests_per_sec=cfg.get("rate_limit_per_sec", 2))


def parse_stooq_csv(ticker: str, text: str) -> list[PriceBar]:
    if not text or text.strip().startswith(_NO_DATA_MARKER):
        return []
    reader = csv.DictReader(io.StringIO(text))
    bars = []
    for row in reader:
        if not row.get("Date"):
            continue
        try:
            bars.append(
                PriceBar(
                    ticker=ticker,
                    trade_date=dt.date.fromisoformat(row["Date"]),
                    open=float(row["Open"]) if row.get("Open") else None,
                    high=float(row["High"]) if row.get("High") else None,
                    low=float(row["Low"]) if row.get("Low") else None,
                    close=float(row["Close"]) if row.get("Close") else None,
                    volume=int(float(row["Volume"])) if row.get("Volume") else None,
                )
            )
        except (KeyError, ValueError):
            continue  # malformed row; caller's RunLogger records the gap via count mismatch
    return bars


def fetch_daily_history(ticker: str, client: HttpClient | None = None) -> list[PriceBar]:
    """Fetch Stooq's full available daily history for one ticker (Stooq has no date-range param
    on the free CSV endpoint; callers filter/dedupe against existing DB rows downstream)."""
    cfg = _load_config()
    client = client or _client()
    symbol = normalize_ticker(ticker).lower()
    url = cfg["daily_csv_url_template"].format(ticker=symbol)
    response = client.get(url)
    raw_path(_SOURCE, timestamped_filename(f"{symbol}_us", "csv")).write_text(response.text)
    return parse_stooq_csv(ticker, response.text)
