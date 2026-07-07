"""Normalize SEC XBRL company-facts observations into `fundamentals` rows."""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select
from sqlalchemy.orm import Session

from src.database.models import Fundamental
from src.ingestion.sec_company_facts import XbrlFact


def _parse_date(value: str | None) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        return None


def upsert_fundamental(session: Session, security_id: int, fact: XbrlFact, source: str = "sec_company_facts") -> bool:
    """Insert or update one XBRL fact row. Returns True if newly inserted."""
    period_end = _parse_date(fact.period_end)
    if period_end is None:
        raise ValueError(f"XBRL fact for tag {fact.tag!r} has no valid period_end")

    existing = session.execute(
        select(Fundamental).where(
            Fundamental.security_id == security_id,
            Fundamental.taxonomy == fact.taxonomy,
            Fundamental.tag == fact.tag,
            Fundamental.unit == fact.unit,
            Fundamental.period_end == period_end,
            Fundamental.fiscal_period == fact.fiscal_period,
            Fundamental.accession_number == fact.accession_number,
        )
    ).scalar_one_or_none()

    if existing is None:
        session.add(
            Fundamental(
                security_id=security_id,
                taxonomy=fact.taxonomy,
                tag=fact.tag,
                unit=fact.unit,
                fiscal_year=fact.fiscal_year,
                fiscal_period=fact.fiscal_period,
                form=fact.form,
                period_start=_parse_date(fact.period_start),
                period_end=period_end,
                filed_date=_parse_date(fact.filed_date),
                value=fact.value,
                accession_number=fact.accession_number,
                source=source,
            )
        )
        return True

    existing.value = fact.value
    existing.filed_date = _parse_date(fact.filed_date) or existing.filed_date
    existing.form = fact.form or existing.form
    return False


def upsert_fundamentals(
    session: Session, security_id: int, facts: list[XbrlFact], source: str = "sec_company_facts"
) -> tuple[int, int]:
    inserted = updated = 0
    for fact in facts:
        try:
            if upsert_fundamental(session, security_id, fact, source):
                inserted += 1
            else:
                updated += 1
        except ValueError:
            continue  # malformed fact (no usable period_end); caller's RunLogger records via count mismatch
    return inserted, updated
