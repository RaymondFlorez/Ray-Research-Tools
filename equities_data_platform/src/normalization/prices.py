"""Normalize raw price bars (Stooq or Yahoo fallback) into `prices` rows, upserted per source.

Prices are keyed by (security_id, trade_date, source) rather than a plain
(security_id, trade_date) key: this lets the platform hold both an
authoritative Stooq bar and a fallback Yahoo bar for the same day without one
silently overwriting the other, and downstream consumers pick a source
preference order explicitly (see api/routes/prices.py).
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from src.database.models import Price
from src.ingestion.stooq_prices import PriceBar


def upsert_price_bar(session: Session, security_id: int, bar: PriceBar, source: str) -> bool:
    """Insert or update one daily bar. Returns True if a new row was inserted, False if updated."""
    existing = session.execute(
        select(Price).where(
            Price.security_id == security_id,
            Price.trade_date == bar.trade_date,
            Price.source == source,
        )
    ).scalar_one_or_none()

    adj_close = bar.adj_close if bar.adj_close is not None else bar.close

    if existing is None:
        session.add(
            Price(
                security_id=security_id,
                trade_date=bar.trade_date,
                open=bar.open,
                high=bar.high,
                low=bar.low,
                close=bar.close,
                adj_close=adj_close,
                volume=bar.volume,
                source=source,
            )
        )
        return True

    existing.open = bar.open
    existing.high = bar.high
    existing.low = bar.low
    existing.close = bar.close
    existing.adj_close = adj_close
    existing.volume = bar.volume
    return False


def upsert_price_bars(session: Session, security_id: int, bars: list[PriceBar], source: str) -> tuple[int, int]:
    """Bulk upsert; returns (inserted_count, updated_count)."""
    inserted = updated = 0
    for bar in bars:
        if upsert_price_bar(session, security_id, bar, source):
            inserted += 1
        else:
            updated += 1
    return inserted, updated
