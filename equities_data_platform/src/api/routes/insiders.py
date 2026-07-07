from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from src.api.deps import get_db
from src.database.models import InsiderTransaction, Security

router = APIRouter(prefix="/insiders", tags=["insiders"])


class InsiderTransactionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    accession_number: str
    reporting_owner_name: str | None
    reporting_owner_cik: str | None
    is_officer: bool
    is_director: bool
    is_ten_percent_owner: bool
    officer_title: str | None
    transaction_date: dt.date | None
    transaction_code: str | None
    shares: float | None
    price_per_share: float | None
    shares_owned_after: float | None
    direct_or_indirect: str | None
    security_title: str | None


@router.get("/{security_id}", response_model=list[InsiderTransactionOut])
def get_insider_transactions(
    security_id: int,
    transaction_code: str | None = Query(None, description="e.g. 'P' (purchase), 'S' (sale)"),
    limit: int = Query(500, le=5000),
    db: Session = Depends(get_db),
) -> list[InsiderTransactionOut]:
    if db.get(Security, security_id) is None:
        raise HTTPException(status_code=404, detail="security not found")

    stmt = select(InsiderTransaction).where(InsiderTransaction.security_id == security_id)
    if transaction_code:
        stmt = stmt.where(InsiderTransaction.transaction_code == transaction_code.upper())
    stmt = stmt.order_by(InsiderTransaction.transaction_date.desc()).limit(limit)

    return [InsiderTransactionOut.model_validate(t) for t in db.execute(stmt).scalars()]
