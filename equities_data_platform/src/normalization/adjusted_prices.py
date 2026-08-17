"""Compute split/dividend-adjusted price series from raw bars plus recorded
corporate actions.

Background: Stooq's free CSV closes are already fully adjusted, which is why
`prices.adj_close` defaults to `close` for that source. This module covers
the other direction -- producing a consistent adjusted series from *raw*
bars using the platform's own `corporate_actions` table, so that:

  * Yahoo-fallback raw OHLC can be adjusted with the same factor logic as
    any other source, rather than trusting a vendor's `adjclose` blindly;
  * API consumers can request "adjust everything as of today" semantics at
    read time without stored rows being rewritten (storage stays raw and
    per-source; adjustment is a read-time transformation).

Convention: standard back-adjustment. A split of ratio R effective on date D
divides every bar strictly BEFORE D by R (and multiplies its volume by R).
A cash dividend of amount X with ex-date D scales every bar before D by
(1 - X / close_of_last_bar_before_D) -- the proportional method CRSP and
most vendors use. The effective date itself already trades at the new basis
and is never touched.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, replace

from src.database.models import CorporateAction, CorporateActionType
from src.ingestion.stooq_prices import PriceBar


@dataclass(frozen=True)
class AdjustmentEvent:
    effective_date: dt.date
    price_factor: float  # multiply prices strictly before effective_date by this
    volume_factor: float  # multiply volume strictly before effective_date by this


def events_from_corporate_actions(actions: list[CorporateAction]) -> list[AdjustmentEvent]:
    """Convert SPLIT/REVERSE_SPLIT/DIVIDEND corporate actions into adjustment events.

    Split actions carry their ratio in `details["ratio"]` (2.0 means 2-for-1;
    a reverse split stores the same convention, e.g. 0.1 for 1-for-10).
    Dividend actions need `details = {"amount": <cash per share>,
    "prior_close": <close before ex-date>}`; both keys must be present for a
    dividend to produce an adjustment -- we never guess the prior close.
    Actions with missing or nonsensical details are skipped, not errored:
    an unadjustable action must not make the whole series unavailable.
    """
    events: list[AdjustmentEvent] = []
    for action in actions:
        details = action.details or {}
        if action.action_type in (CorporateActionType.SPLIT, CorporateActionType.REVERSE_SPLIT):
            ratio = details.get("ratio")
            if not ratio or ratio <= 0:
                continue
            events.append(
                AdjustmentEvent(
                    effective_date=action.effective_date,
                    price_factor=1.0 / ratio,
                    volume_factor=float(ratio),
                )
            )
        elif action.action_type == CorporateActionType.DIVIDEND:
            amount = details.get("amount")
            prior_close = details.get("prior_close")
            if not amount or not prior_close or prior_close <= 0:
                continue
            factor = 1.0 - (float(amount) / float(prior_close))
            if factor <= 0:
                continue
            events.append(
                AdjustmentEvent(
                    effective_date=action.effective_date,
                    price_factor=factor,
                    volume_factor=1.0,
                )
            )
    return sorted(events, key=lambda e: e.effective_date)


def factors_for_date(events: list[AdjustmentEvent], trade_date: dt.date) -> tuple[float, float]:
    """Cumulative (price_factor, volume_factor) applying to a bar on `trade_date`."""
    price_factor = 1.0
    volume_factor = 1.0
    for event in events:
        if trade_date < event.effective_date:
            price_factor *= event.price_factor
            volume_factor *= event.volume_factor
    return price_factor, volume_factor


def compute_adjusted_bars(bars: list[PriceBar], events: list[AdjustmentEvent]) -> list[PriceBar]:
    """Return new PriceBar objects with OHLC/volume back-adjusted through `events`.

    Input bars may be in any order; output preserves the input order. Bars on
    or after every event's effective date come back unchanged (identity
    factors), so re-adjusting an already-current series is a no-op.
    """
    if not events:
        return list(bars)

    adjusted: list[PriceBar] = []
    for bar in bars:
        price_factor, volume_factor = factors_for_date(events, bar.trade_date)
        if price_factor == 1.0 and volume_factor == 1.0:
            adjusted.append(bar)
            continue
        adjusted.append(
            replace(
                bar,
                open=bar.open * price_factor if bar.open is not None else None,
                high=bar.high * price_factor if bar.high is not None else None,
                low=bar.low * price_factor if bar.low is not None else None,
                close=bar.close * price_factor if bar.close is not None else None,
                adj_close=bar.close * price_factor if bar.close is not None else None,
                volume=round(bar.volume * volume_factor) if bar.volume is not None else None,
            )
        )
    return adjusted
