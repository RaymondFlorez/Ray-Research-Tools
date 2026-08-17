"""Build and incrementally update the canonical securities master.

This module is the merge point for every listing-level source (SEC company
tickers, SEC submissions, Nasdaq symbol directory). It never trusts a ticker
as a stable key: matching prefers CIK, falls back to the currently-active
ticker row, and every ticker assignment is versioned with a start/end date so
symbol reuse and reassignment never corrupts history.
"""
from __future__ import annotations

import datetime as dt
import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from src.database.models import (
    CorporateAction,
    CorporateActionType,
    IdentifierType,
    ListingStatus,
    Security,
    SecurityIdentifier,
    SecurityType,
    Ticker,
)
from src.ingestion.nasdaq_symbols import NasdaqSymbolRecord
from src.ingestion.sec_submissions import SubmissionsRecord
from src.ingestion.sec_tickers import SecTickerRecord
from src.normalization.identifiers import normalize_ticker
from src.normalization.sic_codes import sic_to_industry, sic_to_sector

_TYPE_PATTERNS: list[tuple[re.Pattern, SecurityType]] = [
    (re.compile(r"\bwarrants?\b", re.I), SecurityType.WARRANT),
    (re.compile(r"\brights?\b", re.I), SecurityType.RIGHT),
    (re.compile(r"\bunits?\b", re.I), SecurityType.UNIT),
    (re.compile(r"\bpreferred\b|\bpfd\b|\bdepositary shares?\b", re.I), SecurityType.PREFERRED),
    (re.compile(r"\bspecial purpose acquisition\b|\bacquisition corp\b|\bblank check\b", re.I), SecurityType.SPAC),
    (re.compile(r"\bamerican depositary\b|\bads\b|\badr\b", re.I), SecurityType.ADR),
    (re.compile(r"\bclosed[- ]end fund\b|\btrust\b.*\bfund\b", re.I), SecurityType.CLOSED_END_FUND),
    (re.compile(r"\betn\b|\bexchange[- ]traded note\b", re.I), SecurityType.ETN),
]


def classify_security_type(name: str, is_etf: bool = False) -> SecurityType:
    """Best-effort classification from the free-text security/company name plus known flags.

    Free sources do not universally expose a clean security-type field, so
    this is deliberately conservative: unmatched names default to
    COMMON_STOCK rather than guessing wrong on the majority case.
    """
    if is_etf:
        return SecurityType.ETF
    for pattern, sec_type in _TYPE_PATTERNS:
        if pattern.search(name):
            return sec_type
    return SecurityType.COMMON_STOCK


def _find_by_cik(session: Session, cik: str) -> Security | None:
    return session.execute(select(Security).where(Security.cik == cik)).scalar_one_or_none()


def _find_by_active_ticker(session: Session, ticker: str) -> Security | None:
    stmt = (
        select(Security)
        .join(Ticker, Ticker.security_id == Security.security_id)
        .where(Ticker.ticker == ticker, Ticker.end_date.is_(None))
    )
    return session.execute(stmt).scalars().first()


def _current_ticker_row(security: Security) -> Ticker | None:
    open_rows = [t for t in security.tickers if t.end_date is None]
    return open_rows[0] if open_rows else None


def assign_ticker(
    session: Session,
    security: Security,
    ticker: str,
    exchange: str | None,
    as_of: dt.date,
    source: str,
) -> None:
    """Ensure `ticker` is the currently-active symbol for `security` as of `as_of`.

    If the security already has a different active ticker, that row is closed
    (end_date = as_of) and a TICKER_CHANGE corporate action is recorded, then a
    new open-ended Ticker row is created. Re-asserting the same ticker/exchange
    is a no-op.
    """
    ticker = normalize_ticker(ticker)
    current = _current_ticker_row(security)

    if current is not None and current.ticker == ticker:
        if exchange and current.exchange != exchange:
            current.exchange = exchange
        return

    if current is not None and current.ticker != ticker:
        current.end_date = as_of
        security.corporate_actions.append(
            CorporateAction(
                action_type=CorporateActionType.TICKER_CHANGE,
                effective_date=as_of,
                details={"old_ticker": current.ticker, "new_ticker": ticker},
                source=source,
            )
        )

    security.tickers.append(
        Ticker(
            ticker=ticker,
            exchange=exchange,
            start_date=as_of,
            end_date=None,
            is_primary=True,
            source=source,
        )
    )


def upsert_from_sec_ticker(
    session: Session, record: SecTickerRecord, as_of: dt.date | None = None, source: str = "sec_tickers"
) -> Security:
    """Upsert a Security from an SEC company_tickers.json row (has an authoritative CIK)."""
    as_of = as_of or dt.date.today()
    ticker = normalize_ticker(record.ticker)

    security = _find_by_cik(session, record.cik) or _find_by_active_ticker(session, ticker)
    if security is None:
        security = Security(
            cik=record.cik,
            company_name=record.company_name,
            security_type=classify_security_type(record.company_name),
            exchange=record.exchange,
            listing_status=ListingStatus.ACTIVE,
            first_seen_date=as_of,
            last_seen_date=as_of,
            source=source,
        )
        session.add(security)
        session.flush()
    else:
        if security.cik is None:
            security.cik = record.cik
        security.company_name = record.company_name
        if record.exchange:
            security.exchange = record.exchange
        security.listing_status = ListingStatus.ACTIVE
        security.last_seen_date = as_of

    assign_ticker(session, security, ticker, record.exchange, as_of, source)
    return security


def upsert_from_nasdaq_symbol(
    session: Session, record: NasdaqSymbolRecord, as_of: dt.date | None = None, source: str = "nasdaq_symbols"
) -> Security:
    """Upsert a Security from a Nasdaq symbol-directory row (no CIK available)."""
    as_of = as_of or dt.date.today()
    ticker = normalize_ticker(record.symbol)

    security = _find_by_active_ticker(session, ticker)
    if security is None:
        security = Security(
            cik=None,
            company_name=record.security_name,
            security_type=classify_security_type(record.security_name, record.is_etf),
            exchange=record.exchange,
            listing_status=ListingStatus.ACTIVE if not record.is_test_issue else ListingStatus.UNKNOWN,
            is_etf=record.is_etf,
            is_test_issue=record.is_test_issue,
            first_seen_date=as_of,
            last_seen_date=as_of,
            source=source,
        )
        session.add(security)
        session.flush()
    else:
        security.is_etf = record.is_etf
        security.is_test_issue = record.is_test_issue
        security.exchange = record.exchange
        security.listing_status = ListingStatus.ACTIVE
        security.last_seen_date = as_of

    assign_ticker(session, security, ticker, record.exchange, as_of, source)
    return security


def apply_submissions_enrichment(
    session: Session, security: Security, record: SubmissionsRecord, source: str = "sec_submissions"
) -> None:
    """Enrich a Security with SIC/former-name data from the SEC submissions API.

    Former-name transitions become NAME_CHANGE corporate actions so the
    security's naming history is auditable, mirroring how ticker changes are
    tracked in `assign_ticker`.
    """
    security.sic_code = record.sic_code or security.sic_code
    security.sic_description = record.sic_description or security.sic_description
    if security.sic_code:
        security.sector = sic_to_sector(security.sic_code) or security.sector
        security.industry = sic_to_industry(security.sic_code) or security.industry
    if record.company_name:
        security.company_name = record.company_name
    if record.exchanges:
        security.exchange = record.exchanges[0]
    if record.tickers == []:
        security.listing_status = ListingStatus.DELISTED

    existing_dates = {
        ca.effective_date
        for ca in security.corporate_actions
        if ca.action_type == CorporateActionType.NAME_CHANGE
    }
    for former in record.former_names:
        effective = _parse_sec_date(former.end_date) or _parse_sec_date(former.start_date)
        if effective is None or effective in existing_dates:
            continue
        security.corporate_actions.append(
            CorporateAction(
                action_type=CorporateActionType.NAME_CHANGE,
                effective_date=effective,
                details={"former_name": former.name, "start": former.start_date, "end": former.end_date},
                source=source,
            )
        )


def _parse_sec_date(value: str | None) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.datetime.strptime(value.split("T")[0], "%Y-%m-%d").date()
    except ValueError:
        return None


def mark_stale_securities_delisted(session: Session, seen_security_ids: set[int], as_of: dt.date | None = None) -> int:
    """Mark any previously-active security absent from the latest full listing pull as delisted.

    Called once per full daily refresh after every source has been merged, so
    a security must be missing from *every* source's current pull (not just
    one) before we infer delisting.
    """
    as_of = as_of or dt.date.today()
    stmt = select(Security).where(Security.listing_status == ListingStatus.ACTIVE)
    count = 0
    for security in session.execute(stmt).scalars():
        if security.security_id in seen_security_ids:
            continue
        security.listing_status = ListingStatus.DELISTED
        current = _current_ticker_row(security)
        if current is not None:
            current.end_date = as_of
        security.corporate_actions.append(
            CorporateAction(
                action_type=CorporateActionType.DELISTING,
                effective_date=as_of,
                details={"reason": "absent from latest full listing refresh"},
                source="daily_refresh",
            )
        )
        count += 1
    return count


def find_security_by_cusip(session: Session, cusip: str) -> Security | None:
    """Look up a security by a previously-recorded CUSIP identifier.

    NOTE: none of this platform's free/legal sources provide a bulk
    ticker<->CUSIP crosswalk (CUSIPs are licensed data from CUSIP Global
    Services; only the CUSIPs that *appear inside filings we already ingest*,
    e.g. 13F information tables, are available here). This lookup therefore
    only succeeds once `link_cusip` has been called for that security from
    some other signal -- it is a best-effort match, not a guaranteed one.
    """
    if not cusip:
        return None
    stmt = select(SecurityIdentifier).where(
        SecurityIdentifier.id_type == IdentifierType.CUSIP, SecurityIdentifier.id_value == cusip
    )
    identifier = session.execute(stmt).scalars().first()
    return identifier.security if identifier else None


def link_cusip(session: Session, security: Security, cusip: str, source: str) -> None:
    """Record a CUSIP -> security association observed in an ingested filing, deduped."""
    exists = session.execute(
        select(SecurityIdentifier).where(
            SecurityIdentifier.security_id == security.security_id,
            SecurityIdentifier.id_type == IdentifierType.CUSIP,
            SecurityIdentifier.id_value == cusip,
        )
    ).scalar_one_or_none()
    if exists is not None:
        return
    security.identifiers.append(
        SecurityIdentifier(
            id_type=IdentifierType.CUSIP,
            id_value=cusip,
            source=source,
        )
    )
