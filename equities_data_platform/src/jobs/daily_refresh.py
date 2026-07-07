"""Daily refresh job: full securities-master resync (SEC + Nasdaq) and incremental price updates.

Intended to run once per trading day (e.g. via cron/systemd timer). Every
source is wrapped in its own `RunLogger` so a failure in one stage (say,
Stooq being briefly unavailable) does not prevent the securities master
stages from completing, and every stage's outcome is independently auditable
in `ingestion_runs`.
"""
from __future__ import annotations

from sqlalchemy import func, select

from src.common.logging_utils import RunLogger, get_logger
from src.database.db import get_session, init_db
from src.database.models import ListingStatus, Price, Security
from src.ingestion.nasdaq_symbols import fetch_all_symbols
from src.ingestion.sec_tickers import fetch_company_tickers, fetch_company_tickers_with_exchange
from src.ingestion.stooq_prices import fetch_daily_history
from src.normalization.prices import upsert_price_bars
from src.normalization.security_master import (
    mark_stale_securities_delisted,
    upsert_from_nasdaq_symbol,
    upsert_from_sec_ticker,
)

logger = get_logger("jobs.daily_refresh")


def refresh_securities_master() -> set[int]:
    """Merge SEC company tickers + Nasdaq symbol directory into the securities master.

    Returns the set of security_ids observed in this run, used by the caller
    to infer delistings for anything active but absent from both sources.
    """
    seen_ids: set[int] = set()

    with get_session() as session:
        with RunLogger("daily_refresh", "sec_tickers") as run:
            try:
                records = fetch_company_tickers_with_exchange()
            except Exception:
                run.note("company_tickers_exchange.json unavailable; falling back to company_tickers.json")
                records = fetch_company_tickers()
            for rec in records:
                try:
                    security = upsert_from_sec_ticker(session, rec)
                    seen_ids.add(security.security_id)
                    run.record(processed=1, inserted=1)
                except Exception as exc:
                    run.error(rec.ticker, str(exc))

    with get_session() as session:
        with RunLogger("daily_refresh", "nasdaq_symbols") as run:
            for rec in fetch_all_symbols():
                if rec.is_test_issue:
                    continue
                try:
                    security = upsert_from_nasdaq_symbol(session, rec)
                    seen_ids.add(security.security_id)
                    run.record(processed=1)
                except Exception as exc:
                    run.error(rec.symbol, str(exc))

    with get_session() as session:
        with RunLogger("daily_refresh", "delisting_check") as run:
            count = mark_stale_securities_delisted(session, seen_ids)
            run.record(processed=count, updated=count)
            run.note(f"marked {count} securities delisted")

    return seen_ids


def refresh_prices(ticker_limit: int | None = None) -> None:
    """Incrementally fetch the latest daily bars for every active security.

    Stooq's free CSV endpoint always returns full history rather than a date
    range, so incrementality is achieved on the write side: we only insert
    bars newer than the latest bar already stored for that security+source.
    """
    with get_session() as session:
        with RunLogger("daily_refresh", "stooq_prices") as run:
            stmt = select(Security).where(Security.listing_status == ListingStatus.ACTIVE)
            securities = list(session.execute(stmt).scalars())
            if ticker_limit:
                securities = securities[:ticker_limit]

            for security in securities:
                current = next((t for t in security.tickers if t.end_date is None), None)
                if current is None:
                    continue
                try:
                    bars = fetch_daily_history(current.ticker)
                except Exception as exc:
                    run.error(current.ticker, str(exc))
                    continue
                if not bars:
                    continue

                last_date = session.execute(
                    select(func.max(Price.trade_date)).where(
                        Price.security_id == security.security_id, Price.source == "stooq"
                    )
                ).scalar()
                if last_date:
                    bars = [b for b in bars if b.trade_date > last_date]
                if not bars:
                    continue

                inserted, updated = upsert_price_bars(session, security.security_id, bars, "stooq")
                run.record(processed=len(bars), inserted=inserted, updated=updated)


def run(ticker_limit: int | None = None) -> None:
    init_db()
    logger.info("starting daily refresh")
    refresh_securities_master()
    refresh_prices(ticker_limit=ticker_limit)
    logger.info("daily refresh complete")


if __name__ == "__main__":
    run()
