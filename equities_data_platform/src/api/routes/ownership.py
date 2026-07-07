from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import get_db
from src.database.models import InstitutionalHolding, Security

router = APIRouter(prefix="/ownership", tags=["ownership"])


class InstitutionalHoldingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    accession_number: str
    filer_cik: str
    filer_name: str | None
    period_of_report: dt.date | None
    cusip: str | None
    value_usd_thousands: float | None
    shares_or_principal: float | None
    share_type: str | None
    investment_discretion: str | None


@router.get("/{security_id}", response_model=list[InstitutionalHoldingOut])
def get_institutional_ownership(
    security_id: int,
    as_of: dt.date | None = Query(None, description="Filter to a specific 13F period_of_report"),
    limit: int = Query(500, le=5000),
    db: Session = Depends(get_db),
) -> list[InstitutionalHoldingOut]:
    if db.get(Security, security_id) is None:
        raise HTTPException(status_code=404, detail="security not found")

    stmt = select(InstitutionalHolding).where(InstitutionalHolding.security_id == security_id)
    if as_of:
        stmt = stmt.where(InstitutionalHolding.period_of_report == as_of)
    stmt = stmt.order_by(InstitutionalHolding.value_usd_thousands.desc()).limit(limit)

    return [InstitutionalHoldingOut.model_validate(h) for h in db.execute(stmt).scalars()]
