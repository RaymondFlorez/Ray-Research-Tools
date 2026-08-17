import datetime as dt

import pytest

from src.database.models import CorporateAction, CorporateActionType, ListingStatus, Security
from src.ingestion.stooq_prices import PriceBar
from src.normalization.adjusted_prices import (
    AdjustmentEvent,
    compute_adjusted_bars,
    events_from_corporate_actions,
    factors_for_date,
)


def _bar(day: int, close: float, volume: int = 1000) -> PriceBar:
    return PriceBar("TEST", dt.date(2024, 1, day), close, close, close, close, volume)


def _split_action(day: int, ratio: float) -> CorporateAction:
    action_type = CorporateActionType.SPLIT if ratio >= 1 else CorporateActionType.REVERSE_SPLIT
    return CorporateAction(
        action_type=action_type,
        effective_date=dt.date(2024, 1, day),
        details={"ratio": ratio},
        source="test",
    )


def test_split_back_adjusts_prior_bars_only():
    # 2-for-1 split effective Jan 10: bars before Jan 10 halve, Jan 10+ untouched.
    bars = [_bar(5, 100.0), _bar(9, 110.0), _bar(10, 55.0), _bar(11, 56.0)]
    events = events_from_corporate_actions([_split_action(10, 2.0)])

    adjusted = compute_adjusted_bars(bars, events)

    assert adjusted[0].close == pytest.approx(50.0)
    assert adjusted[0].volume == 2000
    assert adjusted[1].close == pytest.approx(55.0)
    assert adjusted[2].close == pytest.approx(55.0)  # effective date: unchanged
    assert adjusted[2].volume == 1000
    assert adjusted[3].close == pytest.approx(56.0)


def test_reverse_split_scales_prior_bars_up():
    # 1-for-10 reverse split (ratio 0.1): pre-split $1 bars become $10.
    bars = [_bar(5, 1.0), _bar(15, 10.0)]
    events = events_from_corporate_actions([_split_action(10, 0.1)])

    adjusted = compute_adjusted_bars(bars, events)

    assert adjusted[0].close == pytest.approx(10.0)
    assert adjusted[0].volume == 100
    assert adjusted[1].close == pytest.approx(10.0)


def test_multiple_splits_compound():
    # Two 2-for-1 splits: oldest bars carry both factors (4x), middle bars one (2x).
    bars = [_bar(1, 400.0), _bar(11, 210.0), _bar(21, 105.0)]
    events = events_from_corporate_actions([_split_action(10, 2.0), _split_action(20, 2.0)])

    adjusted = compute_adjusted_bars(bars, events)

    assert adjusted[0].close == pytest.approx(100.0)
    assert adjusted[1].close == pytest.approx(105.0)
    assert adjusted[2].close == pytest.approx(105.0)


def test_dividend_adjustment_uses_prior_close():
    # $1 dividend, prior close $50 -> factor 0.98 on earlier bars; volume untouched.
    dividend = CorporateAction(
        action_type=CorporateActionType.DIVIDEND,
        effective_date=dt.date(2024, 1, 10),
        details={"amount": 1.0, "prior_close": 50.0},
        source="test",
    )
    bars = [_bar(5, 50.0), _bar(10, 49.0)]

    adjusted = compute_adjusted_bars(bars, events_from_corporate_actions([dividend]))

    assert adjusted[0].close == pytest.approx(49.0)
    assert adjusted[0].volume == 1000
    assert adjusted[1].close == pytest.approx(49.0)


def test_actions_with_missing_or_bad_details_are_skipped():
    bad = [
        CorporateAction(
            action_type=CorporateActionType.SPLIT,
            effective_date=dt.date(2024, 1, 10),
            details=None,
            source="test",
        ),
        CorporateAction(
            action_type=CorporateActionType.DIVIDEND,
            effective_date=dt.date(2024, 1, 11),
            details={"amount": 1.0},  # no prior_close -> cannot adjust
            source="test",
        ),
        CorporateAction(
            action_type=CorporateActionType.TICKER_CHANGE,
            effective_date=dt.date(2024, 1, 12),
            details={"old_ticker": "A", "new_ticker": "B"},
            source="test",
        ),
    ]
    assert events_from_corporate_actions(bad) == []


def test_no_events_returns_bars_unchanged():
    bars = [_bar(5, 100.0)]
    assert compute_adjusted_bars(bars, []) == bars


def test_factors_for_date_boundary():
    events = [AdjustmentEvent(dt.date(2024, 1, 10), 0.5, 2.0)]
    assert factors_for_date(events, dt.date(2024, 1, 9)) == (0.5, 2.0)
    assert factors_for_date(events, dt.date(2024, 1, 10)) == (1.0, 1.0)


def test_prices_api_adjusted_param():
    """End-to-end: /prices/{id}?adjusted=true applies recorded splits at read time."""
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    from src.api.app import app
    from src.api.deps import get_db
    from src.database.models import Base, Price

    # TestClient serves requests from a worker thread; StaticPool pins the
    # in-memory SQLite database to one shared connection so both threads see it.
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db_session = sessionmaker(bind=engine, expire_on_commit=False)()

    security = Security(company_name="Split Corp", listing_status=ListingStatus.ACTIVE)
    db_session.add(security)
    db_session.flush()

    db_session.add_all(
        [
            Price(
                security_id=security.security_id,
                trade_date=dt.date(2024, 1, 5),
                open=100.0,
                high=101.0,
                low=99.0,
                close=100.0,
                adj_close=100.0,
                volume=1000,
                source="yahoo_fallback",
            ),
            Price(
                security_id=security.security_id,
                trade_date=dt.date(2024, 1, 10),
                open=50.0,
                high=51.0,
                low=49.0,
                close=50.0,
                adj_close=50.0,
                volume=2000,
                source="yahoo_fallback",
            ),
        ]
    )
    action = _split_action(10, 2.0)
    action.security_id = security.security_id
    db_session.add(action)
    db_session.commit()

    app.dependency_overrides[get_db] = lambda: db_session
    client = TestClient(app)
    try:
        raw = client.get(f"/prices/{security.security_id}").json()
        assert raw[0]["close"] == pytest.approx(100.0)

        adjusted = client.get(f"/prices/{security.security_id}", params={"adjusted": "true"}).json()
        assert adjusted[0]["close"] == pytest.approx(50.0)
        assert adjusted[0]["volume"] == 2000
        assert adjusted[1]["close"] == pytest.approx(50.0)  # post-split bar unchanged
        assert adjusted[1]["volume"] == 2000
    finally:
        app.dependency_overrides.clear()
        db_session.close()
