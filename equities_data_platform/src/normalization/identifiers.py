"""Normalization and validation helpers for security identifiers (CIK, CUSIP, ticker)."""
from __future__ import annotations

import re

_TICKER_RE = re.compile(r"^[A-Z]{1,6}([.\-][A-Z0-9]{1,3})?$")


def normalize_cik(cik: int | str) -> str:
    """Zero-pad a CIK to SEC's canonical 10-digit string form (e.g. 320193 -> '0000320193')."""
    digits = str(cik).strip().lstrip("CIK").lstrip("cik").strip()
    if not digits.isdigit():
        raise ValueError(f"CIK must be numeric, got {cik!r}")
    return digits.zfill(10)


def normalize_ticker(ticker: str) -> str:
    """Uppercase and standardize a ticker symbol.

    Exchanges/vendors are inconsistent about class-share separators (BRK.B vs
    BRK-B vs BRKB); we standardize on a dash, matching Stooq/Nasdaq convention,
    while preserving the original as `raw_ticker` at the call site if needed.
    """
    if not ticker:
        raise ValueError("ticker must be non-empty")
    normalized = ticker.strip().upper().replace(" ", "")
    normalized = normalized.replace(".", "-")
    return normalized


def ticker_to_stooq_symbol(ticker: str) -> str:
    """Stooq wants lowercase, dash-separated class shares, and a '.us' suffix, e.g. 'brk-b.us'."""
    normalized = normalize_ticker(ticker).lower()
    return f"{normalized}.us"


def is_valid_ticker_format(ticker: str) -> bool:
    try:
        normalized = normalize_ticker(ticker)
    except ValueError:
        return False
    return bool(_TICKER_RE.match(normalized))


def cusip_check_digit(cusip8: str) -> int:
    """Compute the CUSIP check digit for the first 8 characters using the standard modulus-10 algorithm."""
    total = 0
    for i, ch in enumerate(cusip8):
        if ch.isdigit():
            v = int(ch)
        elif ch.isalpha():
            v = ord(ch.upper()) - ord("A") + 10
        elif ch == "*":
            v = 36
        elif ch == "@":
            v = 37
        elif ch == "#":
            v = 38
        else:
            raise ValueError(f"Invalid CUSIP character: {ch!r}")
        if i % 2 == 1:  # even position (0-indexed odd) is doubled
            v *= 2
        total += v // 10 + v % 10
    return (10 - (total % 10)) % 10


def is_valid_cusip(cusip: str) -> bool:
    """Validate a 9-character CUSIP's check digit. Returns False for malformed input rather than raising."""
    if not cusip or len(cusip) != 9:
        return False
    body, check = cusip[:8], cusip[8]
    if not check.isdigit():
        return False
    try:
        return cusip_check_digit(body) == int(check)
    except ValueError:
        return False


def normalize_cusip(cusip: str) -> str:
    return cusip.strip().upper()
