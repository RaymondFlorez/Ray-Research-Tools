from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import get_db
from src.database.models import Filing, Security

router = APIRouter(prefix="/filings", tags=["filings"])


class FilingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    accession_number: str
    cik: str
    form_type: str
    filing_date: dt.date
    period_of_report: dt.date | None
    primary_doc_url: str | None


@router.get("/{security_id}", response_model=list[FilingOut])
def get_filings(
    security_id: int,
    form_type: str | None = Query(None, description="e.g. '10-K', '4', '13F-HR'"),
    limit: int = Query(200, le=2000),
    db: Session = Depends(get_db),
) -> list[FilingOut]:
    if db.get(Security, security_id) is None:
        raise HTTPException(status_code=404, detail="security not found")

    stmt = select(Filing).where(Filing.security_id == security_id)
    if form_type:
        stmt = stmt.where(Filing.form_type == form_type)
    stmt = stmt.order_by(Filing.filing_date.desc()).limit(limit)

    return [FilingOut.model_validate(f) for f in db.execute(stmt).scalars()]
