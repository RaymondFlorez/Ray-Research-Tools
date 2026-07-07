"""Quarterly refresh job: fundamentals (XBRL), company profile enrichment, Forms 3/4/5,
and 13F institutional ownership.

These sources update far less often than daily prices/listings (fundamentals
land with each 10-K/10-Q; 13F-HR is filed within 45 days of quarter-end), and
carry a much heavier per-CIK request cost, so they run on their own quarterly
cadence rather than daily.
"""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select

from src.common.logging_utils import RunLogger, get_logger
from src.common.sec_index import fetch_quarterly_form_index
from src.database.db import get_session, init_db
from src.database.models import Filing, Security
from src.ingestion.sec_13f import fetch_information_table, guess_information_table_document
from src.ingestion.sec_company_facts import fetch_company_facts
from src.ingestion.sec_forms import fetch_form4
from src.ingestion.sec_submissions import fetch_submissions
from src.normalization.fundamentals import upsert_fundamentals
from src.normalization.security_master import apply_submissions_enrichment, find_security_by_cusip

logger = get_logger("jobs.quarterly_refresh")


def refresh_fundamentals(cik_limit: int | None = None) -> None:
    with get_session() as session:
        with RunLogger("quarterly_refresh", "sec_company_facts") as run:
            stmt = select(Security).where(Security.cik.isnot(None))
            securities = list(session.execute(stmt).scalars())
            if cik_limit:
                securities = securities[:cik_limit]

            for security in securities:
                try:
                    facts = fetch_company_facts(security.cik)
                except Exception as exc:
                    run.error(security.cik, str(exc))
                    continue
                inserted, updated = upsert_fundamentals(session, security.security_id, facts)
                run.record(processed=len(facts), inserted=inserted, updated=updated)


def refresh_company_profiles(cik_limit: int | None = None) -> None:
    """Re-pull SEC submissions per company for SIC/former-name enrichment and delisting signal."""
    with get_session() as session:
        with RunLogger("quarterly_refresh", "sec_submissions") as run:
            stmt = select(Security).where(Security.cik.isnot(None))
            securities = list(session.execute(stmt).scalars())
            if cik_limit:
                securities = securities[:cik_limit]

            for security in securities:
                try:
                    submission = fetch_submissions(security.cik)
                except Exception as exc:
                    run.error(security.cik, str(exc))
                    continue
                apply_submissions_enrichment(session, security, submission)
                run.record(processed=1, updated=1)


def refresh_insider_transactions(year: int, quarter: int, filing_limit: int | None = None) -> None:
    from src.database.models import InsiderTransaction

    with get_session() as session:
        with RunLogger("quarterly_refresh", "sec_forms") as run:
            entries = fetch_quarterly_form_index(year, quarter, form_types={"3", "4", "5"})
            if filing_limit:
                entries = entries[:filing_limit]

            for entry in entries:
                if session.get(Filing, entry.accession_number) is not None:
                    continue  # already ingested
                try:
                    transactions = fetch_form4(entry.cik, entry.accession_number)
                except Exception as exc:
                    run.error(entry.accession_number, str(exc))
                    continue

                security = session.execute(select(Security).where(Security.cik == entry.cik)).scalars().first()
                filing_date = _parse_index_date(entry.date_filed)
                session.add(
                    Filing(
                        accession_number=entry.accession_number,
                        cik=entry.cik,
                        security_id=security.security_id if security else None,
                        form_type=entry.form_type,
                        filing_date=filing_date or dt.date.today(),
                        source="sec_forms",
                    )
                )
                for txn in transactions:
                    session.add(
                        InsiderTransaction(
                            accession_number=entry.accession_number,
                            security_id=security.security_id if security else None,
                            reporting_owner_cik=txn.reporting_owner_cik,
                            reporting_owner_name=txn.reporting_owner_name,
                            is_officer=txn.is_officer,
                            is_director=txn.is_director,
                            is_ten_percent_owner=txn.is_ten_percent_owner,
                            officer_title=txn.officer_title,
                            transaction_date=txn.transaction_date,
                            transaction_code=txn.transaction_code,
                            shares=txn.shares,
                            price_per_share=txn.price_per_share,
                            shares_owned_after=txn.shares_owned_after,
                            direct_or_indirect=txn.direct_or_indirect,
                            security_title=txn.security_title,
                        )
                    )
                run.record(processed=len(transactions), inserted=len(transactions))


def refresh_institutional_ownership(year: int, quarter: int, filing_limit: int | None = None) -> None:
    from src.database.models import InstitutionalHolding

    with get_session() as session:
        with RunLogger("quarterly_refresh", "sec_13f") as run:
            entries = fetch_quarterly_form_index(year, quarter, form_types={"13F-HR"})
            if filing_limit:
                entries = entries[:filing_limit]

            for entry in entries:
                if session.get(Filing, entry.accession_number) is not None:
                    continue  # already ingested

                doc = guess_information_table_document(entry.cik, entry.accession_number)
                if doc is None:
                    run.error(entry.accession_number, "no information-table XML found in filing directory")
                    continue
                try:
                    holdings = fetch_information_table(entry.cik, entry.accession_number, doc, entry.company_name)
                except Exception as exc:
                    run.error(entry.accession_number, str(exc))
                    continue

                filing_date = _parse_index_date(entry.date_filed)
                session.add(
                    Filing(
                        accession_number=entry.accession_number,
                        cik=entry.cik,
                        form_type=entry.form_type,
                        filing_date=filing_date or dt.date.today(),
                        source="sec_13f",
                    )
                )
                for holding in holdings:
                    matched = find_security_by_cusip(session, holding.cusip) if holding.cusip else None
                    session.add(
                        InstitutionalHolding(
                            accession_number=entry.accession_number,
                            filer_cik=holding.filer_cik,
                            filer_name=holding.filer_name,
                            period_of_report=filing_date,
                            security_id=matched.security_id if matched else None,
                            cusip=holding.cusip,
                            issuer_name=holding.issuer_name,
                            value_usd_thousands=holding.value_usd_thousands,
                            shares_or_principal=holding.shares_or_principal,
                            share_type=holding.share_type,
                            investment_discretion=holding.investment_discretion,
                            voting_authority_sole=holding.voting_authority_sole,
                        )
                    )
                run.record(processed=len(holdings), inserted=len(holdings))


def _parse_index_date(value: str) -> dt.date | None:
    try:
        return dt.date.fromisoformat(value)
    except (ValueError, TypeError):
        return None


def _current_quarter() -> tuple[int, int]:
    today = dt.date.today()
    return today.year, (today.month - 1) // 3 + 1


def run(year: int | None = None, quarter: int | None = None, limit: int | None = None) -> None:
    init_db()
    year = year or _current_quarter()[0]
    quarter = quarter or _current_quarter()[1]
    logger.info("starting quarterly refresh for %d QTR%d", year, quarter)
    refresh_fundamentals(cik_limit=limit)
    refresh_company_profiles(cik_limit=limit)
    refresh_insider_transactions(year, quarter, filing_limit=limit)
    refresh_institutional_ownership(year, quarter, filing_limit=limit)
    logger.info("quarterly refresh complete")


if __name__ == "__main__":
    run()
