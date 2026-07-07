"""Corporate action detection and recording.

Ticker changes, name changes, and inferred delistings are recorded directly
by `security_master.py` at the point they're detected (it already has the
old/new values in hand). This module covers the remaining case: detecting
stock splits by comparing a source's raw close against its dividend/split
-adjusted close, which is the only free signal available for splits without
a dedicated corporate-actions feed.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.orm import Session

from src.database.models import CorporateAction, CorporateActionType

# A day-over-day jump in the raw/adjusted close ratio bigger than this is treated
# as a split rather than rounding noise (e.g. a 2-for-1 split produces ~2.0).
_SPLIT_RATIO_TOLERANCE = 0.03


def detect_splits_from_price_pairs(
    bars: list[tuple[dt.date, float | None, float | None]],
) -> list[tuple[dt.date, float]]:
    """Given (trade_date, close, adj_close) tuples sorted ascending by date, return
    (effective_date, ratio) pairs where the close/adj_close ratio shifts materially
    day-over-day, indicating an unadjusted split event.
    """
    splits: list[tuple[dt.date, float]] = []
    prev_ratio: float | None = None
    for trade_date, close, adj_close in bars:
        if not close or not adj_close:
            continue
        ratio = close / adj_close
        if prev_ratio is not None and prev_ratio > 0:
            delta = abs(ratio - prev_ratio) / prev_ratio
            if delta > _SPLIT_RATIO_TOLERANCE:
                splits.append((trade_date, round(ratio / prev_ratio, 4)))
        prev_ratio = ratio
    return splits


def record_split(
    session: Session, security_id: int, effective_date: dt.date, ratio: float, source: str
) -> CorporateAction | None:
    """Record a SPLIT (ratio > 1) or REVERSE_SPLIT (ratio < 1) corporate action, deduped by date."""
    existing = session.execute(
        select(CorporateAction).where(
            CorporateAction.security_id == security_id,
            CorporateAction.effective_date == effective_date,
            CorporateAction.action_type.in_([CorporateActionType.SPLIT, CorporateActionType.REVERSE_SPLIT]),
        )
    ).scalar_one_or_none()
    if existing is not None:
        return None

    action_type = CorporateActionType.SPLIT if ratio >= 1 else CorporateActionType.REVERSE_SPLIT
    action = CorporateAction(
        security_id=security_id,
        action_type=action_type,
        effective_date=effective_date,
        details={"ratio": ratio},
        source=source,
    )
    session.add(action)
    return action


def get_corporate_action_history(session: Session, security_id: int) -> list[CorporateAction]:
    stmt = (
        select(CorporateAction)
        .where(CorporateAction.security_id == security_id)
        .order_by(CorporateAction.effective_date.asc())
    )
    return list(session.execute(stmt).scalars())
