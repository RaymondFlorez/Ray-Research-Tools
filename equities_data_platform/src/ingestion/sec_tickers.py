"""Ingest SEC's company_tickers.json and company_tickers_exchange.json.

These are the SEC's own authoritative ticker <-> CIK <-> company-name mapping
files, refreshed by the SEC intraday. They are the backbone of the securities
master's CIK linkage. Source: https://www.sec.gov/os/webmaster-faq#developers
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import yaml

from src.common.http import HttpClient, sec_user_agent
from src.common.paths import PROJECT_ROOT, raw_path, timestamped_filename

_SOURCE = "sec_tickers"


def _load_config() -> dict:
    with open(PROJECT_ROOT / "config" / "sources.yaml") as fh:
        return yaml.safe_load(fh)["sec"]


@dataclass
class SecTickerRecord:
    cik: str
    ticker: str
    company_name: str
    exchange: str | None = None


def _client() -> HttpClient:
    cfg = _load_config()
    return HttpClient(user_agent=sec_user_agent(), requests_per_sec=cfg.get("rate_limit_per_sec", 5))


def fetch_company_tickers(client: HttpClient | None = None) -> list[SecTickerRecord]:
    """Fetch and parse company_tickers.json: {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}}."""
    cfg = _load_config()
    client = client or _client()
    response = client.get(cfg["company_tickers_url"])
    raw_file = raw_path(_SOURCE, timestamped_filename("company_tickers", "json"))
    raw_file.write_bytes(response.content)

    payload = response.json()
    records = []
    for row in payload.values():
        records.append(
            SecTickerRecord(
                cik=str(row["cik_str"]).zfill(10),
                ticker=str(row["ticker"]).upper(),
                company_name=row["title"],
            )
        )
    return records


def fetch_company_tickers_with_exchange(client: HttpClient | None = None) -> list[SecTickerRecord]:
    """Fetch company_tickers_exchange.json, which additionally carries the listing exchange.

    Schema: {"fields": ["cik","name","ticker","exchange"], "data": [[320193,"Apple Inc.","AAPL","Nasdaq"], ...]}
    """
    cfg = _load_config()
    client = client or _client()
    response = client.get(cfg["company_tickers_exchange_url"])
    raw_file = raw_path(_SOURCE, timestamped_filename("company_tickers_exchange", "json"))
    raw_file.write_bytes(response.content)

    payload = response.json()
    fields = payload["fields"]
    records = []
    for row in payload["data"]:
        rec = dict(zip(fields, row))
        records.append(
            SecTickerRecord(
                cik=str(rec["cik"]).zfill(10),
                ticker=str(rec["ticker"]).upper(),
                company_name=rec["name"],
                exchange=rec.get("exchange") or None,
            )
        )
    return records


def parse_company_tickers_bytes(content: bytes) -> list[SecTickerRecord]:
    """Pure parsing path (no network) used by tests and by callers replaying a saved raw file."""
    payload = json.loads(content)
    return [
        SecTickerRecord(
            cik=str(row["cik_str"]).zfill(10),
            ticker=str(row["ticker"]).upper(),
            company_name=row["title"],
        )
        for row in payload.values()
    ]
