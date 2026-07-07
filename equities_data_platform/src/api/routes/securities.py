from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import get_db
from src.database.models import Security, Ticker

router = APIRouter(prefix="/securities", tags=["securities"])


class TickerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    ticker: str
    exchange: str | None
    start_date: dt.date
    end_date: dt.date | None
    is_primary: bool


class SecurityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    security_id: int
    permanent_id: str
    cik: str | None
    company_name: str
    security_type: str
    exchange: str | None
    listing_status: str
    sic_code: str | None
    sic_description: str | None
    sector: str | None
    industry: str | None
    is_etf: bool
    current_ticker: str | None = None


def _to_security_out(security: Security) -> SecurityOut:
    out = SecurityOut.model_validate(security)
    current = next((t for t in security.tickers if t.end_date is None), None)
    out.current_ticker = current.ticker if current else None
    return out


@router.get("", response_model=list[SecurityOut])
def list_securities(
    ticker: str | None = Query(None, description="Current ticker symbol, case-insensitive"),
    cik: str | None = Query(None),
    exchange: str | None = Query(None),
    security_type: str | None = Query(None),
    listing_status: str | None = Query(None),
    limit: int = Query(50, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
) -> list[SecurityOut]:
    stmt = select(Security)
    if ticker:
        stmt = stmt.join(Ticker, Ticker.security_id == Security.security_id).where(
            Ticker.ticker == ticker.upper(), Ticker.end_date.is_(None)
        )
    if cik:
        stmt = stmt.where(Security.cik == cik.zfill(10))
    if exchange:
        stmt = stmt.where(Security.exchange == exchange)
    if security_type:
        stmt = stmt.where(Security.security_type == security_type)
    if listing_status:
        stmt = stmt.where(Security.listing_status == listing_status)
    stmt = stmt.offset(offset).limit(limit)

    results = db.execute(stmt).scalars().unique().all()
    return [_to_security_out(s) for s in results]


@router.get("/{security_id}", response_model=SecurityOut)
def get_security(security_id: int, db: Session = Depends(get_db)) -> SecurityOut:
    security = db.get(Security, security_id)
    if security is None:
        raise HTTPException(status_code=404, detail="security not found")
    return _to_security_out(security)


@router.get("/{security_id}/tickers", response_model=list[TickerOut])
def get_security_tickers(security_id: int, db: Session = Depends(get_db)) -> list[TickerOut]:
    security = db.get(Security, security_id)
    if security is None:
        raise HTTPException(status_code=404, detail="security not found")
    ordered = sorted(security.tickers, key=lambda t: t.start_date)
    return [TickerOut.model_validate(t) for t in ordered]
