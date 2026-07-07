"""Ingest Nasdaq's daily symbol directory: nasdaqlisted.txt and otherlisted.txt.

These pipe-delimited files are Nasdaq Trader's free, public listing directory
covering every symbol listed on Nasdaq (nasdaqlisted.txt) and every symbol
listed on NYSE/NYSE American/Cboe/IEX/etc. that clears through the Nasdaq UTP
plan (otherlisted.txt). Together they are the most complete free source of
"what is listed right now" for U.S. exchanges, including ETF flags.
"""
from __future__ import annotations

import csv
import io
from dataclasses import dataclass

import yaml

from src.common.http import HttpClient
from src.common.paths import PROJECT_ROOT, raw_path, timestamped_filename

_SOURCE = "nasdaq_symbols"

# NYSE MKT/ARCA/etc single-letter exchange codes used in otherlisted.txt.
_OTHER_EXCHANGE_CODES = {
    "A": "NYSE American",
    "N": "NYSE",
    "P": "NYSE Arca",
    "Z": "Cboe BZX",
    "V": "IEXG",
}


@dataclass
class NasdaqSymbolRecord:
    symbol: str
    security_name: str
    exchange: str
    is_etf: bool
    is_test_issue: bool
    listing_status: str = "active"  # both files only ever list currently-active symbols


def _load_config() -> dict:
    with open(PROJECT_ROOT / "config" / "sources.yaml") as fh:
        return yaml.safe_load(fh)["nasdaq"]


def _client() -> HttpClient:
    # Nasdaq Trader's directory does not require a special User-Agent or contact string,
    # but we still identify ourselves as good API citizenship.
    return HttpClient(user_agent="equities-data-platform (open-source, free-data pipeline)", requests_per_sec=2)


def _parse_pipe_delimited(text: str) -> list[dict]:
    # Both files end with a "File Creation Time" footer row that must be dropped.
    lines = [ln for ln in text.splitlines() if ln and not ln.startswith("File Creation Time")]
    reader = csv.DictReader(io.StringIO("\n".join(lines)), delimiter="|")
    return list(reader)


def parse_nasdaq_listed(text: str) -> list[NasdaqSymbolRecord]:
    records = []
    for row in _parse_pipe_delimited(text):
        symbol = (row.get("Symbol") or "").strip()
        if not symbol:
            continue
        records.append(
            NasdaqSymbolRecord(
                symbol=symbol,
                security_name=(row.get("Security Name") or "").strip(),
                exchange="Nasdaq",
                is_etf=(row.get("ETF") or "N").strip().upper() == "Y",
                is_test_issue=(row.get("Test Issue") or "N").strip().upper() == "Y",
            )
        )
    return records


def parse_other_listed(text: str) -> list[NasdaqSymbolRecord]:
    records = []
    for row in _parse_pipe_delimited(text):
        symbol = (row.get("ACT Symbol") or row.get("NASDAQ Symbol") or "").strip()
        if not symbol:
            continue
        exch_code = (row.get("Exchange") or "").strip()
        records.append(
            NasdaqSymbolRecord(
                symbol=symbol,
                security_name=(row.get("Security Name") or "").strip(),
                exchange=_OTHER_EXCHANGE_CODES.get(exch_code, exch_code or "Other"),
                is_etf=(row.get("ETF") or "N").strip().upper() == "Y",
                is_test_issue=(row.get("Test Issue") or "N").strip().upper() == "Y",
            )
        )
    return records


def fetch_nasdaq_listed(client: HttpClient | None = None) -> list[NasdaqSymbolRecord]:
    cfg = _load_config()
    client = client or _client()
    response = client.get(cfg["nasdaq_listed_url"])
    raw_path(_SOURCE, timestamped_filename("nasdaqlisted", "txt")).write_text(response.text)
    return parse_nasdaq_listed(response.text)


def fetch_other_listed(client: HttpClient | None = None) -> list[NasdaqSymbolRecord]:
    cfg = _load_config()
    client = client or _client()
    response = client.get(cfg["other_listed_url"])
    raw_path(_SOURCE, timestamped_filename("otherlisted", "txt")).write_text(response.text)
    return parse_other_listed(response.text)


def fetch_all_symbols(client: HttpClient | None = None) -> list[NasdaqSymbolRecord]:
    client = client or _client()
    return fetch_nasdaq_listed(client) + fetch_other_listed(client)
