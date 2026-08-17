"""SQLAlchemy ORM models for the U.S. equities securities master and related data.

Design notes:
  * `Security.security_id` is a surrogate integer primary key. Tickers are
    NEVER used as a primary or foreign key anywhere in this schema, because
    tickers are reused, recycled, and reassigned by exchanges over time.
  * `Security.permanent_id` is a stable, externally-safe UUID that API
    consumers can key off of without depending on autoincrement internals.
  * Historical ticker support lives in `Ticker`, a many-rows-per-security
    table with `start_date`/`end_date` validity windows.
"""
from __future__ import annotations

import datetime as dt
import enum
import uuid

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _uuid() -> str:
    return str(uuid.uuid4())


def _utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


class SecurityType(str, enum.Enum):
    COMMON_STOCK = "common_stock"
    ETF = "etf"
    ADR = "adr"
    PREFERRED = "preferred"
    WARRANT = "warrant"
    RIGHT = "right"
    UNIT = "unit"
    SPAC = "spac"
    CLOSED_END_FUND = "closed_end_fund"
    ETN = "etn"
    OTHER = "other"


class ListingStatus(str, enum.Enum):
    ACTIVE = "active"
    DELISTED = "delisted"
    UNKNOWN = "unknown"


class IdentifierType(str, enum.Enum):
    CIK = "CIK"
    CUSIP = "CUSIP"
    FIGI = "FIGI"
    ISIN = "ISIN"


class CorporateActionType(str, enum.Enum):
    TICKER_CHANGE = "ticker_change"
    NAME_CHANGE = "name_change"
    SPLIT = "split"
    REVERSE_SPLIT = "reverse_split"
    DIVIDEND = "dividend"
    DELISTING = "delisting"
    LISTING = "listing"
    MERGER = "merger"


class RunStatus(str, enum.Enum):
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    PARTIAL = "partial"


class ErrorSeverity(str, enum.Enum):
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class Security(Base):
    """Canonical securities master row. One row per distinct listed security."""

    __tablename__ = "securities"

    security_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    permanent_id: Mapped[str] = mapped_column(String(36), unique=True, index=True, default=_uuid)

    cik: Mapped[str | None] = mapped_column(String(10), index=True, nullable=True)
    company_name: Mapped[str] = mapped_column(String(512), nullable=False)

    security_type: Mapped[SecurityType] = mapped_column(
        Enum(SecurityType, native_enum=False, length=32), default=SecurityType.OTHER
    )
    exchange: Mapped[str | None] = mapped_column(String(32), nullable=True)
    listing_status: Mapped[ListingStatus] = mapped_column(
        Enum(ListingStatus, native_enum=False, length=16), default=ListingStatus.UNKNOWN
    )

    sic_code: Mapped[str | None] = mapped_column(String(8), nullable=True)
    sic_description: Mapped[str | None] = mapped_column(String(256), nullable=True)
    sector: Mapped[str | None] = mapped_column(String(128), nullable=True)
    industry: Mapped[str | None] = mapped_column(String(128), nullable=True)

    is_etf: Mapped[bool] = mapped_column(Boolean, default=False)
    is_test_issue: Mapped[bool] = mapped_column(Boolean, default=False)

    first_seen_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    last_seen_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)

    source: Mapped[str] = mapped_column(String(64), default="sec_tickers")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    tickers: Mapped[list[Ticker]] = relationship(back_populates="security", cascade="all, delete-orphan")
    identifiers: Mapped[list[SecurityIdentifier]] = relationship(
        back_populates="security", cascade="all, delete-orphan"
    )
    prices: Mapped[list[Price]] = relationship(back_populates="security", cascade="all, delete-orphan")
    corporate_actions: Mapped[list[CorporateAction]] = relationship(
        back_populates="security", cascade="all, delete-orphan"
    )

    __table_args__ = (Index("ix_securities_cik_name", "cik", "company_name"),)

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<Security id={self.security_id} name={self.company_name!r}>"


class Ticker(Base):
    """Historical ticker-symbol mapping. Many rows per security over time."""

    __tablename__ = "tickers"

    ticker_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    security_id: Mapped[int] = mapped_column(ForeignKey("securities.security_id"), nullable=False, index=True)

    ticker: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    exchange: Mapped[str | None] = mapped_column(String(32), nullable=True)

    start_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    end_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)  # NULL = currently in effect
    is_primary: Mapped[bool] = mapped_column(Boolean, default=True)

    source: Mapped[str] = mapped_column(String(64), default="sec_tickers")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    security: Mapped[Security] = relationship(back_populates="tickers")

    __table_args__ = (
        Index("ix_tickers_ticker_active", "ticker", "end_date"),
        UniqueConstraint("security_id", "ticker", "start_date", name="uq_ticker_security_start"),
    )


class SecurityIdentifier(Base):
    """Generic external identifier crosswalk (CIK/CUSIP/FIGI/ISIN) with validity windows."""

    __tablename__ = "security_identifiers"

    identifier_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    security_id: Mapped[int] = mapped_column(ForeignKey("securities.security_id"), nullable=False, index=True)

    id_type: Mapped[IdentifierType] = mapped_column(Enum(IdentifierType, native_enum=False, length=16))
    id_value: Mapped[str] = mapped_column(String(64), index=True)

    start_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    end_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=True)

    source: Mapped[str] = mapped_column(String(64), default="sec")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    security: Mapped[Security] = relationship(back_populates="identifiers")

    __table_args__ = (
        UniqueConstraint("id_type", "id_value", "security_id", name="uq_identifier_type_value_security"),
    )


class Price(Base):
    """Daily OHLCV bar for a security from a specific source."""

    __tablename__ = "prices"

    price_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    security_id: Mapped[int] = mapped_column(ForeignKey("securities.security_id"), nullable=False, index=True)

    trade_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    open: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    high: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    low: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    close: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    adj_close: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    volume: Mapped[int | None] = mapped_column(Integer, nullable=True)

    source: Mapped[str] = mapped_column(String(32), default="stooq")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    security: Mapped[Security] = relationship(back_populates="prices")

    __table_args__ = (
        UniqueConstraint("security_id", "trade_date", "source", name="uq_price_security_date_source"),
        Index("ix_prices_security_date", "security_id", "trade_date"),
    )


class CorporateAction(Base):
    """Derived corporate action events: ticker changes, name changes, splits, delistings."""

    __tablename__ = "corporate_actions"

    action_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    security_id: Mapped[int] = mapped_column(ForeignKey("securities.security_id"), nullable=False, index=True)

    action_type: Mapped[CorporateActionType] = mapped_column(
        Enum(CorporateActionType, native_enum=False, length=32)
    )
    effective_date: Mapped[dt.date] = mapped_column(Date, nullable=False)
    details: Mapped[dict | None] = mapped_column(JSON, nullable=True)

    source: Mapped[str] = mapped_column(String(64), default="sec_submissions")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    security: Mapped[Security] = relationship(back_populates="corporate_actions")

    __table_args__ = (Index("ix_corp_actions_security_date", "security_id", "effective_date"),)


class Fundamental(Base):
    """A single normalized XBRL fact from SEC company facts (one company/tag/period/unit row)."""

    __tablename__ = "fundamentals"

    fundamental_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    security_id: Mapped[int] = mapped_column(ForeignKey("securities.security_id"), nullable=False, index=True)

    taxonomy: Mapped[str] = mapped_column(String(16))  # us-gaap, dei, ifrs-full, etc.
    tag: Mapped[str] = mapped_column(String(128), index=True)  # e.g. Assets, Revenues
    unit: Mapped[str] = mapped_column(String(32))  # USD, USD/shares, shares

    fiscal_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fiscal_period: Mapped[str | None] = mapped_column(String(4), nullable=True)  # FY, Q1..Q4
    form: Mapped[str | None] = mapped_column(String(16), nullable=True)  # 10-K, 10-Q

    period_start: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    period_end: Mapped[dt.date] = mapped_column(Date, nullable=False)
    filed_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)

    value: Mapped[float] = mapped_column(Numeric(28, 4))
    accession_number: Mapped[str | None] = mapped_column(String(32), nullable=True)

    source: Mapped[str] = mapped_column(String(64), default="sec_company_facts")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (
        UniqueConstraint(
            "security_id", "taxonomy", "tag", "unit", "period_end", "fiscal_period", "accession_number",
            name="uq_fundamental_fact",
        ),
        Index("ix_fundamentals_security_tag", "security_id", "tag"),
    )


class Filing(Base):
    """A single SEC filing (any form type), used as the parent for forms 3/4/5 and 13F parsing."""

    __tablename__ = "filings"

    accession_number: Mapped[str] = mapped_column(String(32), primary_key=True)
    cik: Mapped[str] = mapped_column(String(10), index=True)
    security_id: Mapped[int | None] = mapped_column(ForeignKey("securities.security_id"), nullable=True, index=True)

    form_type: Mapped[str] = mapped_column(String(16), index=True)
    filing_date: Mapped[dt.date] = mapped_column(Date)
    period_of_report: Mapped[dt.date | None] = mapped_column(Date, nullable=True)

    primary_doc_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    raw_path: Mapped[str | None] = mapped_column(String(512), nullable=True)

    source: Mapped[str] = mapped_column(String(64), default="sec_forms")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (Index("ix_filings_cik_form", "cik", "form_type"),)


class InsiderTransaction(Base):
    """A single reported transaction line from a Form 3/4/5 filing."""

    __tablename__ = "insider_transactions"

    transaction_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    accession_number: Mapped[str] = mapped_column(ForeignKey("filings.accession_number"), index=True)
    security_id: Mapped[int | None] = mapped_column(ForeignKey("securities.security_id"), nullable=True, index=True)

    reporting_owner_cik: Mapped[str | None] = mapped_column(String(10), nullable=True)
    reporting_owner_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    is_officer: Mapped[bool] = mapped_column(Boolean, default=False)
    is_director: Mapped[bool] = mapped_column(Boolean, default=False)
    is_ten_percent_owner: Mapped[bool] = mapped_column(Boolean, default=False)
    officer_title: Mapped[str | None] = mapped_column(String(128), nullable=True)

    transaction_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    transaction_code: Mapped[str | None] = mapped_column(String(4), nullable=True)  # P, S, A, F, ...
    shares: Mapped[float | None] = mapped_column(Numeric(20, 4), nullable=True)
    price_per_share: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    shares_owned_after: Mapped[float | None] = mapped_column(Numeric(20, 4), nullable=True)
    direct_or_indirect: Mapped[str | None] = mapped_column(String(1), nullable=True)  # D/I
    security_title: Mapped[str | None] = mapped_column(String(128), nullable=True)

    source: Mapped[str] = mapped_column(String(64), default="sec_forms")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (Index("ix_insider_txn_security_date", "security_id", "transaction_date"),)


class InstitutionalHolding(Base):
    """A single position line from a 13F-HR information table."""

    __tablename__ = "institutional_holdings"

    holding_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    accession_number: Mapped[str] = mapped_column(ForeignKey("filings.accession_number"), index=True)

    filer_cik: Mapped[str] = mapped_column(String(10), index=True)
    filer_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    period_of_report: Mapped[dt.date | None] = mapped_column(Date, nullable=True)

    security_id: Mapped[int | None] = mapped_column(ForeignKey("securities.security_id"), nullable=True, index=True)
    cusip: Mapped[str | None] = mapped_column(String(9), nullable=True, index=True)
    issuer_name: Mapped[str | None] = mapped_column(String(256), nullable=True)

    value_usd_thousands: Mapped[float | None] = mapped_column(Numeric(20, 2), nullable=True)
    shares_or_principal: Mapped[float | None] = mapped_column(Numeric(20, 2), nullable=True)
    share_type: Mapped[str | None] = mapped_column(String(8), nullable=True)  # SH or PRN
    investment_discretion: Mapped[str | None] = mapped_column(String(8), nullable=True)
    voting_authority_sole: Mapped[float | None] = mapped_column(Numeric(20, 2), nullable=True)

    source: Mapped[str] = mapped_column(String(64), default="sec_13f")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    __table_args__ = (Index("ix_holdings_security", "security_id"),)


class IngestionRun(Base):
    """Audit record for a single execution of an ingestion/job pipeline."""

    __tablename__ = "ingestion_runs"

    run_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_name: Mapped[str] = mapped_column(String(64), index=True)
    source: Mapped[str] = mapped_column(String(64))

    started_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[RunStatus] = mapped_column(Enum(RunStatus, native_enum=False, length=16), default=RunStatus.RUNNING)

    records_processed: Mapped[int] = mapped_column(Integer, default=0)
    records_inserted: Mapped[int] = mapped_column(Integer, default=0)
    records_updated: Mapped[int] = mapped_column(Integer, default=0)
    error_count: Mapped[int] = mapped_column(Integer, default=0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    errors: Mapped[list[ErrorLog]] = relationship(back_populates="run", cascade="all, delete-orphan")


class ErrorLog(Base):
    """A single error/warning captured during an ingestion run, for audit and debugging."""

    __tablename__ = "error_log"

    error_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[int | None] = mapped_column(ForeignKey("ingestion_runs.run_id"), nullable=True, index=True)

    source: Mapped[str] = mapped_column(String(64))
    entity_ref: Mapped[str | None] = mapped_column(String(256), nullable=True)  # e.g. ticker/cik/accession
    severity: Mapped[ErrorSeverity] = mapped_column(
        Enum(ErrorSeverity, native_enum=False, length=16), default=ErrorSeverity.ERROR
    )
    message: Mapped[str] = mapped_column(Text)
    raised_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    run: Mapped[IngestionRun | None] = relationship(back_populates="errors")
