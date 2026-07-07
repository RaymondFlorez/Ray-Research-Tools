"""One-time (or re-run-as-needed) historical backfill: full securities master,
full price history, and full fundamentals history.

Unlike `daily_refresh.refresh_prices`, this pulls and upserts a security's
*entire* available history rather than only bars newer than what's stored,
and it does not restrict itself to currently-active securities -- delisted
names still need their historical prices for backtesting.
"""
from __future__ import annotations

from sqlalchemy import select

from src.common.logging_utils import RunLogger, get_logger
from src.database.db import get_session, init_db
from src.database.models import Security
from src.ingestion.stooq_prices import fetch_daily_history
from src.jobs.daily_refresh import refresh_securities_master
from src.jobs.quarterly_refresh import refresh_fundamentals, refresh_institutional_ownership, refresh_insider_transactions
from src.normalization.prices import upsert_price_bars

logger = get_logger("jobs.backfill")


def backfill_prices(ticker_limit: int | None = None) -> None:
    with get_session() as session:
        with RunLogger("backfill", "stooq_prices") as run:
            securities = list(session.execute(select(Security)).scalars())
            if ticker_limit:
                securities = securities[:ticker_limit]

            for security in securities:
                # Prefer the most recent ticker on record (works for delisted names too).
                if not security.tickers:
                    continue
                ticker = sorted(security.tickers, key=lambda t: t.start_date)[-1].ticker
                try:
                    bars = fetch_daily_history(ticker)
                except Exception as exc:
                    run.error(ticker, str(exc))
                    continue
                if not bars:
                    continue
                inserted, updated = upsert_price_bars(session, security.security_id, bars, "stooq")
                run.record(processed=len(bars), inserted=inserted, updated=updated)


def backfill_quarters(start_year: int, start_quarter: int, end_year: int, end_quarter: int) -> None:
    """Backfill Forms 3/4/5 and 13F-HR across a range of historical quarters."""
    year, quarter = start_year, start_quarter
    while (year, quarter) <= (end_year, end_quarter):
        logger.info("backfilling insider/13F filings for %d QTR%d", year, quarter)
        refresh_insider_transactions(year, quarter)
        refresh_institutional_ownership(year, quarter)
        quarter += 1
        if quarter > 4:
            quarter = 1
            year += 1


def run(ticker_limit: int | None = None, cik_limit: int | None = None) -> None:
    """Full cold-start backfill: securities master -> fundamentals -> price history."""
    init_db()
    logger.info("starting full backfill")
    refresh_securities_master()
    refresh_fundamentals(cik_limit=cik_limit)
    backfill_prices(ticker_limit=ticker_limit)
    logger.info("backfill complete")


if __name__ == "__main__":
    run()
