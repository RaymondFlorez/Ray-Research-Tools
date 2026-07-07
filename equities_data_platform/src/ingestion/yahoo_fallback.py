"""OPTIONAL fallback price source using Yahoo Finance's unofficial chart API.

This is deliberately kept separate from stooq_prices.py and disabled by
default (ENABLE_YAHOO_FALLBACK=false). Yahoo's endpoint is undocumented and
not an official public API, so:
  * every record produced here is tagged source="yahoo_fallback" downstream,
    never conflated with authoritative SEC/Nasdaq/Stooq data;
  * it is only ever invoked by jobs when the primary source (Stooq) returns
    no data for a symbol;
  * no authentication bypass, scraping of paginated HTML, or rate-limit
    evasion is performed -- this calls the same public JSON endpoint a
    browser would load, at a conservative rate.
"""
from __future__ import annotations

import datetime as dt
import os

import yaml

from src.common.http import HttpClient
from src.common.paths import PROJECT_ROOT, raw_path, timestamped_filename
from src.ingestion.stooq_prices import PriceBar
from src.normalization.identifiers import normalize_ticker

_SOURCE = "yahoo_fallback"


class YahooFallbackDisabled(RuntimeError):
    pass


def _load_config() -> dict:
    with open(PROJECT_ROOT / "config" / "sources.yaml") as fh:
        return yaml.safe_load(fh)["yahoo_fallback"]


def is_enabled() -> bool:
    cfg = _load_config()
    return os.getenv(cfg["enabled_env"], "false").strip().lower() in {"1", "true", "yes"}


def _client() -> HttpClient:
    cfg = _load_config()
    return HttpClient(user_agent="Mozilla/5.0 (compatible; equities-data-platform fallback fetcher)",
                       requests_per_sec=cfg.get("rate_limit_per_sec", 1))


def parse_chart_payload(ticker: str, payload: dict) -> tuple[list[PriceBar], list[float | None]]:
    result = (payload.get("chart", {}).get("result") or [None])[0]
    if not result:
        return [], []
    timestamps = result.get("timestamp", [])
    quote = (result.get("indicators", {}).get("quote") or [{}])[0]
    adjclose = (result.get("indicators", {}).get("adjclose") or [{}])[0].get("adjclose", [])

    padded_adjclose = adjclose or [None] * len(timestamps)
    bars = []
    for i, ts in enumerate(timestamps):
        try:
            bars.append(
                PriceBar(
                    ticker=ticker,
                    trade_date=dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc).date(),
                    open=quote.get("open", [None] * len(timestamps))[i],
                    high=quote.get("high", [None] * len(timestamps))[i],
                    low=quote.get("low", [None] * len(timestamps))[i],
                    close=quote.get("close", [None] * len(timestamps))[i],
                    volume=quote.get("volume", [None] * len(timestamps))[i],
                    adj_close=padded_adjclose[i] if i < len(padded_adjclose) else None,
                )
            )
        except (IndexError, TypeError):
            continue
    return bars, padded_adjclose


def fetch_daily_history(ticker: str, client: HttpClient | None = None) -> list[PriceBar]:
    if not is_enabled():
        raise YahooFallbackDisabled(
            "Yahoo fallback is disabled. Set ENABLE_YAHOO_FALLBACK=true to allow this optional, "
            "unofficial source to be used when Stooq has no data for a symbol."
        )
    cfg = _load_config()
    client = client or _client()
    symbol = normalize_ticker(ticker)
    url = cfg["chart_url_template"].format(ticker=symbol)
    response = client.get(url, params={"range": "max", "interval": "1d", "events": "div,splits"})
    raw_path(_SOURCE, timestamped_filename(symbol, "json")).write_bytes(response.content)

    bars, _adjclose = parse_chart_payload(ticker, response.json())
    return bars
