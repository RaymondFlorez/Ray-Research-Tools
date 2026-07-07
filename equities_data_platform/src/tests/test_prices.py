import datetime as dt

from src.database.models import ListingStatus, Price, Security
from src.ingestion.stooq_prices import PriceBar, parse_stooq_csv
from src.normalization.prices import upsert_price_bars


def _make_security(session) -> Security:
    security = Security(company_name="Apple Inc.", listing_status=ListingStatus.ACTIVE)
    session.add(security)
    session.flush()
    return security


def test_parse_stooq_csv_happy_path():
    csv_text = (
        "Date,Open,High,Low,Close,Volume\n"
        "2024-01-02,185.0,186.5,184.0,185.6,50000000\n"
        "2024-01-03,185.6,187.0,185.0,186.2,48000000\n"
    )
    bars = parse_stooq_csv("AAPL", csv_text)
    assert len(bars) == 2
    assert bars[0].trade_date == dt.date(2024, 1, 2)
    assert bars[0].close == 185.6
    assert bars[1].volume == 48000000


def test_parse_stooq_csv_no_data_marker_returns_empty():
    assert parse_stooq_csv("ZZZZ", "No data") == []
    assert parse_stooq_csv("ZZZZ", "") == []


def test_parse_stooq_csv_skips_malformed_rows():
    csv_text = "Date,Open,High,Low,Close,Volume\n2024-01-02,not-a-number,186.5,184.0,185.6,5000\n"
    assert parse_stooq_csv("AAPL", csv_text) == []


def test_upsert_price_bars_inserts_new_rows(db_session):
    security = _make_security(db_session)
    bars = [
        PriceBar("AAPL", dt.date(2024, 1, 2), 185.0, 186.5, 184.0, 185.6, 50_000_000),
        PriceBar("AAPL", dt.date(2024, 1, 3), 185.6, 187.0, 185.0, 186.2, 48_000_000),
    ]
    inserted, updated = upsert_price_bars(db_session, security.security_id, bars, source="stooq")
    db_session.commit()

    assert inserted == 2
    assert updated == 0
    rows = db_session.query(Price).filter_by(security_id=security.security_id).all()
    assert len(rows) == 2
    # Stooq's close is already split/dividend adjusted; adj_close defaults to close.
    assert float(rows[0].adj_close) == float(rows[0].close)


def test_upsert_price_bars_updates_existing_row_idempotently(db_session):
    security = _make_security(db_session)
    bar = PriceBar("AAPL", dt.date(2024, 1, 2), 185.0, 186.5, 184.0, 185.6, 50_000_000)

    inserted, updated = upsert_price_bars(db_session, security.security_id, [bar], source="stooq")
    db_session.commit()
    assert (inserted, updated) == (1, 0)

    revised_bar = PriceBar("AAPL", dt.date(2024, 1, 2), 185.0, 186.5, 184.0, 190.0, 51_000_000)
    inserted, updated = upsert_price_bars(db_session, security.security_id, [revised_bar], source="stooq")
    db_session.commit()
    assert (inserted, updated) == (0, 1)

    rows = db_session.query(Price).filter_by(security_id=security.security_id).all()
    assert len(rows) == 1
    assert float(rows[0].close) == 190.0


def test_upsert_price_bars_keeps_sources_independent(db_session):
    security = _make_security(db_session)
    stooq_bar = PriceBar("AAPL", dt.date(2024, 1, 2), 185.0, 186.5, 184.0, 185.6, 50_000_000)
    yahoo_bar = PriceBar("AAPL", dt.date(2024, 1, 2), 185.1, 186.6, 184.1, 185.7, 50_100_000)

    upsert_price_bars(db_session, security.security_id, [stooq_bar], source="stooq")
    upsert_price_bars(db_session, security.security_id, [yahoo_bar], source="yahoo_fallback")
    db_session.commit()

    rows = db_session.query(Price).filter_by(security_id=security.security_id).all()
    assert len(rows) == 2
    assert {r.source for r in rows} == {"stooq", "yahoo_fallback"}
