import datetime as dt

from src.database.models import CorporateActionType, ListingStatus, SecurityType
from src.ingestion.nasdaq_symbols import NasdaqSymbolRecord
from src.ingestion.sec_submissions import FormerName, SubmissionsRecord
from src.ingestion.sec_tickers import SecTickerRecord
from src.normalization.security_master import (
    apply_submissions_enrichment,
    assign_ticker,
    classify_security_type,
    mark_stale_securities_delisted,
    upsert_from_nasdaq_symbol,
    upsert_from_sec_ticker,
)


def test_classify_security_type_common_stock_default():
    assert classify_security_type("Apple Inc.") == SecurityType.COMMON_STOCK


def test_classify_security_type_detects_warrant_and_preferred_and_etf():
    assert classify_security_type("Acme Corp Warrants") == SecurityType.WARRANT
    assert classify_security_type("Acme Corp 6% Preferred Stock") == SecurityType.PREFERRED
    assert classify_security_type("SPDR S&P 500", is_etf=True) == SecurityType.ETF


def test_upsert_from_sec_ticker_creates_new_security(db_session):
    rec = SecTickerRecord(cik="0000320193", ticker="AAPL", company_name="Apple Inc.", exchange="Nasdaq")
    security = upsert_from_sec_ticker(db_session, rec, as_of=dt.date(2024, 1, 1))
    db_session.commit()

    assert security.cik == "0000320193"
    assert security.company_name == "Apple Inc."
    assert security.listing_status == ListingStatus.ACTIVE
    assert [t.ticker for t in security.tickers] == ["AAPL"]
    assert security.permanent_id  # a stable external UUID was assigned


def test_upsert_from_sec_ticker_is_keyed_by_cik_not_ticker(db_session):
    rec = SecTickerRecord(cik="0000320193", ticker="AAPL", company_name="Apple Inc.")
    security_1 = upsert_from_sec_ticker(db_session, rec, as_of=dt.date(2024, 1, 1))
    db_session.commit()

    # Same CIK, different ticker -> must update the SAME security row, not create a new one.
    rec_changed = SecTickerRecord(cik="0000320193", ticker="AAPLX", company_name="Apple Inc.")
    security_2 = upsert_from_sec_ticker(db_session, rec_changed, as_of=dt.date(2024, 6, 1))
    db_session.commit()

    assert security_1.security_id == security_2.security_id
    tickers = sorted(security_2.tickers, key=lambda t: t.start_date)
    assert [t.ticker for t in tickers] == ["AAPL", "AAPLX"]
    assert tickers[0].end_date == dt.date(2024, 6, 1)
    assert tickers[1].end_date is None

    actions = [a for a in security_2.corporate_actions if a.action_type == CorporateActionType.TICKER_CHANGE]
    assert len(actions) == 1
    assert actions[0].details == {"old_ticker": "AAPL", "new_ticker": "AAPLX"}


def test_assign_ticker_reasserting_same_ticker_is_a_no_op(db_session):
    rec = SecTickerRecord(cik="0000320193", ticker="AAPL", company_name="Apple Inc.")
    security = upsert_from_sec_ticker(db_session, rec, as_of=dt.date(2024, 1, 1))
    db_session.commit()

    assign_ticker(db_session, security, "AAPL", "Nasdaq", dt.date(2024, 2, 1), source="sec_tickers")
    db_session.commit()

    assert len(security.tickers) == 1
    assert security.tickers[0].start_date == dt.date(2024, 1, 1)


def test_upsert_from_nasdaq_symbol_creates_security_without_cik(db_session):
    rec = NasdaqSymbolRecord(
        symbol="SPY", security_name="SPDR S&P 500 ETF Trust", exchange="NYSE Arca",
        is_etf=True, is_test_issue=False,
    )
    security = upsert_from_nasdaq_symbol(db_session, rec, as_of=dt.date(2024, 1, 1))
    db_session.commit()

    assert security.cik is None
    assert security.is_etf is True
    assert security.security_type == SecurityType.ETF
    assert security.tickers[0].ticker == "SPY"


def test_upsert_from_nasdaq_symbol_matches_existing_active_ticker(db_session):
    sec_rec = SecTickerRecord(cik="0000320193", ticker="AAPL", company_name="Apple Inc.")
    security_1 = upsert_from_sec_ticker(db_session, sec_rec, as_of=dt.date(2024, 1, 1))
    db_session.commit()

    nasdaq_rec = NasdaqSymbolRecord(
        symbol="AAPL", security_name="Apple Inc. - Common Stock", exchange="Nasdaq",
        is_etf=False, is_test_issue=False,
    )
    security_2 = upsert_from_nasdaq_symbol(db_session, nasdaq_rec, as_of=dt.date(2024, 1, 2))
    db_session.commit()

    assert security_1.security_id == security_2.security_id
    assert len(security_2.tickers) == 1  # matched existing row, did not create a duplicate


def test_apply_submissions_enrichment_records_name_changes(db_session):
    rec = SecTickerRecord(cik="0000320193", ticker="AAPL", company_name="Apple Inc.")
    security = upsert_from_sec_ticker(db_session, rec, as_of=dt.date(2020, 1, 1))
    db_session.commit()

    submission = SubmissionsRecord(
        cik="0000320193",
        company_name="Apple Inc.",
        sic_code="3571",
        sic_description="Electronic Computers",
        exchanges=["Nasdaq"],
        tickers=["AAPL"],
        former_names=[FormerName(name="Apple Computer Inc.", start_date="1980-01-01", end_date="2007-01-01")],
    )
    apply_submissions_enrichment(db_session, security, submission)
    db_session.commit()

    assert security.sic_code == "3571"
    assert security.sic_description == "Electronic Computers"
    name_changes = [a for a in security.corporate_actions if a.action_type == CorporateActionType.NAME_CHANGE]
    assert len(name_changes) == 1
    assert name_changes[0].details["former_name"] == "Apple Computer Inc."

    # Re-applying the same submission must not duplicate the corporate action.
    apply_submissions_enrichment(db_session, security, submission)
    db_session.commit()
    name_changes = [a for a in security.corporate_actions if a.action_type == CorporateActionType.NAME_CHANGE]
    assert len(name_changes) == 1


def test_apply_submissions_enrichment_marks_delisted_when_no_tickers(db_session):
    rec = SecTickerRecord(cik="0000320193", ticker="AAPL", company_name="Apple Inc.")
    security = upsert_from_sec_ticker(db_session, rec, as_of=dt.date(2020, 1, 1))
    db_session.commit()

    submission = SubmissionsRecord(
        cik="0000320193", company_name="Apple Inc.", sic_code=None, sic_description=None, tickers=[],
    )
    apply_submissions_enrichment(db_session, security, submission)
    assert security.listing_status == ListingStatus.DELISTED


def test_mark_stale_securities_delisted(db_session):
    rec = SecTickerRecord(cik="0000320193", ticker="AAPL", company_name="Apple Inc.")
    security = upsert_from_sec_ticker(db_session, rec, as_of=dt.date(2024, 1, 1))
    db_session.commit()

    count = mark_stale_securities_delisted(db_session, seen_security_ids=set(), as_of=dt.date(2024, 2, 1))
    db_session.commit()

    assert count == 1
    assert security.listing_status == ListingStatus.DELISTED
    assert security.tickers[0].end_date == dt.date(2024, 2, 1)
    delistings = [a for a in security.corporate_actions if a.action_type == CorporateActionType.DELISTING]
    assert len(delistings) == 1


def test_mark_stale_securities_delisted_skips_seen_securities(db_session):
    rec = SecTickerRecord(cik="0000320193", ticker="AAPL", company_name="Apple Inc.")
    security = upsert_from_sec_ticker(db_session, rec, as_of=dt.date(2024, 1, 1))
    db_session.commit()

    count = mark_stale_securities_delisted(db_session, seen_security_ids={security.security_id})
    assert count == 0
    assert security.listing_status == ListingStatus.ACTIVE
