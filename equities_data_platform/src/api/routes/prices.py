from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import get_db
from src.database.models import Price, Security

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

    return [PriceOut.model_validate(p) for p in db.execute(stmt).scalars()]
