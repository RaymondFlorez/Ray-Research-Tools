import pytest

from src.normalization.identifiers import (
    is_valid_cusip,
    is_valid_ticker_format,
    normalize_cik,
    normalize_ticker,
    ticker_to_stooq_symbol,
)


def test_normalize_cik_pads_to_ten_digits():
    assert normalize_cik(320193) == "0000320193"
    assert normalize_cik("320193") == "0000320193"
    assert normalize_cik("0000320193") == "0000320193"


def test_normalize_cik_rejects_non_numeric():
    with pytest.raises(ValueError):
        normalize_cik("not-a-cik")


def test_normalize_ticker_uppercases_and_dashes_class_shares():
    assert normalize_ticker("aapl") == "AAPL"
    assert normalize_ticker("brk.b") == "BRK-B"
    assert normalize_ticker(" msft ") == "MSFT"


def test_ticker_to_stooq_symbol():
    assert ticker_to_stooq_symbol("BRK.B") == "brk-b.us"
    assert ticker_to_stooq_symbol("AAPL") == "aapl.us"


def test_is_valid_ticker_format():
    assert is_valid_ticker_format("AAPL")
    assert is_valid_ticker_format("BRK.B")
    assert not is_valid_ticker_format("")
    assert not is_valid_ticker_format("TOOLONGTICKER")


def test_is_valid_cusip_true_for_known_good_cusip():
    # Apple Inc. common stock CUSIP
    assert is_valid_cusip("037833100")


def test_is_valid_cusip_false_for_bad_check_digit():
    assert not is_valid_cusip("037833109")


def test_is_valid_cusip_false_for_malformed_input():
    assert not is_valid_cusip("")
    assert not is_valid_cusip("12345")
    assert not is_valid_cusip(None)
