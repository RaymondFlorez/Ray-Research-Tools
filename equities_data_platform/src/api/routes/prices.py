from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import get_db
from src.database.models import CorporateAction, Price, Security
from src.normalization.adjusted_prices import events_from_corporate_actions, factors_for_date

router = APIRouter(prefix="/prices", tags=["prices"])


class PriceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    trade_date: dt.date
    open: float | None
    high: float | None
    low: float | None
    close: float | None
    adj_close: float | None
    volume: int | None
    source: str


@router.get("/{security_id}", response_model=list[PriceOut])
def get_prices(
    security_id: int,
    start: dt.date | None = Query(None),
    end: dt.date | None = Query(None),
    source: str | None = Query(None, description="Filter to one source, e.g. 'stooq' or 'yahoo_fallback'"),
    adjusted: bool = Query(
        False,
        description=(
            "Back-adjust OHLC/volume through recorded split/dividend corporate actions. "
            "Adjustment is computed at read time from the corporate_actions table; stored "
            "rows are never rewritten. Note Stooq bars are already vendor-adjusted -- "
            "this flag is chiefly for raw sources such as yahoo_fallback."
        ),
    ),
    limit: int = Query(5000, le=20000),
    db: Session = Depends(get_db),
) -> list[PriceOut]:
    if db.get(Security, security_id) is None:
        raise HTTPException(status_code=404, detail="security not found")

    stmt = select(Price).where(Price.security_id == security_id)
    if start:
        stmt = stmt.where(Price.trade_date >= start)
    if end:
        stmt = stmt.where(Price.trade_date <= end)
    if source:
        stmt = stmt.where(Price.source == source)
    stmt = stmt.order_by(Price.trade_date.asc()).limit(limit)
    rows = list(db.execute(stmt).scalars())

    if not adjusted:
        return [PriceOut.model_validate(p) for p in rows]

    actions = list(
        db.execute(
            select(CorporateAction).where(CorporateAction.security_id == security_id)
        ).scalars()
    )
    events = events_from_corporate_actions(actions)

    out: list[PriceOut] = []
    for p in rows:
        price_factor, volume_factor = factors_for_date(events, p.trade_date)
        out.append(
            PriceOut(
                trade_date=p.trade_date,
                open=float(p.open) * price_factor if p.open is not None else None,
                high=float(p.high) * price_factor if p.high is not None else None,
                low=float(p.low) * price_factor if p.low is not None else None,
                close=float(p.close) * price_factor if p.close is not None else None,
                adj_close=float(p.close) * price_factor if p.close is not None else None,
                volume=round(p.volume * volume_factor) if p.volume is not None else None,
                source=p.source,
            )
        )
    return out
