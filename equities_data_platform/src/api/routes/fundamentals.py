from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import get_db
from src.database.models import Fundamental, Security

router = APIRouter(prefix="/fundamentals", tags=["fundamentals"])


class FundamentalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    taxonomy: str
    tag: str
    unit: str
    fiscal_year: int | None
    fiscal_period: str | None
    form: str | None
    period_start: dt.date | None
    period_end: dt.date
    filed_date: dt.date | None
    value: float


@router.get("/{security_id}", response_model=list[FundamentalOut])
def get_fundamentals(
    security_id: int,
    tag: str | None = Query(None, description="XBRL tag, e.g. 'Assets' or 'Revenues'"),
    taxonomy: str | None = Query(None, description="e.g. 'us-gaap' or 'dei'"),
    limit: int = Query(1000, le=20000),
    db: Session = Depends(get_db),
) -> list[FundamentalOut]:
    if db.get(Security, security_id) is None:
        raise HTTPException(status_code=404, detail="security not found")

    stmt = select(Fundamental).where(Fundamental.security_id == security_id)
    if tag:
        stmt = stmt.where(Fundamental.tag == tag)
    if taxonomy:
        stmt = stmt.where(Fundamental.taxonomy == taxonomy)
    stmt = stmt.order_by(Fundamental.period_end.desc()).limit(limit)

    return [FundamentalOut.model_validate(f) for f in db.execute(stmt).scalars()]
