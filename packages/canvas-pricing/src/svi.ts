/**
 * The SVI surface (PRD 5.4).
 *
 * > Surface fit via SVI per expiry with arbitrage constraints (Gatheral-Jacquier
 * > no-butterfly, no-calendar conditions) and an explicit flag when the
 * > constraints cannot be satisfied, which is itself information.
 *
 * The fit and the density check are in `pricing-core` (`svi.rs`), which says
 * why each decision was made. What this module adds is the surface: one fit per
 * expiry, and the calendar condition between neighbouring expiries, which no
 * single slice can check.
 *
 * Calendar violations are reported, not repaired. Repairing one means refitting
 * two slices jointly and trading fit on one expiry against the other, and which
 * way to trade is the analyst's call — the report says where and how badly.
 */

import type { PricingExports } from './module.js';

export interface SviParams {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

export interface SviSliceFit {
  params: SviParams;
  /** Implied-vol RMSE: 0.01 is one vol point. */
  rmseVol: number;
  /** The smallest value of Gatheral-Jacquier's `g` on the check grid, and where. */
  minDensity: number;
  minDensityAt: number;
}

export interface SviSlice {
  time: number;
  expiry?: string;
  /** Fitted with the no-butterfly constraint. This is the one to use. */
  fit: SviSliceFit;
  /** Fitted without it, kept so the cost of the constraint is visible. */
  unconstrained: SviSliceFit;
  /** Extra vol RMSE paid to remove butterfly arbitrage. */
  arbitrageCostVol: number;
  /**
   * The quotes cannot be fitted by SVI without butterfly arbitrage.
   *
   * PRD 5.4's "explicit flag", and "itself information": these quotes imply a
   * negative density somewhere, and a smooth arbitrage-free slice cannot pass
   * through them. `arbitrageCostVol` says how far it had to move.
   */
  quotesAdmitArbitrage: boolean;
  message?: string;
}

export interface VolQuote {
  strike: number;
  vol: number;
}

export interface ExpiryQuotes {
  time: number;
  forward: number;
  quotes: readonly VolQuote[];
  expiry?: string;
}

export class NotEnoughQuotes extends Error {
  constructor(readonly expiry: string, readonly count: number) {
    super(`${expiry}: ${count} quote(s) cannot fit five SVI parameters`);
    this.name = 'NotEnoughQuotes';
  }
}

function read(w: PricingExports, offset: number): SviSliceFit {
  const r = (i: number) => w.pc_svi_result(offset + i);
  return {
    params: { a: r(0), b: r(1), rho: r(2), m: r(3), sigma: r(4) },
    rmseVol: r(5),
    minDensity: r(6),
    minDensityAt: r(7),
  };
}

export function fitSviSlice(exports: PricingExports, input: ExpiryQuotes): SviSlice {
  const w = exports;
  w.pc_svi_reset();
  for (const quote of input.quotes) w.pc_svi_quote(quote.strike, input.forward, quote.vol, input.time);
  const label = input.expiry ?? `${(input.time * 365).toFixed(0)}d`;
  if (w.pc_svi_fit(input.time) !== 1) throw new NotEnoughQuotes(label, input.quotes.length);

  const slice: SviSlice = {
    time: input.time,
    fit: read(w, 0),
    unconstrained: read(w, 8),
    arbitrageCostVol: w.pc_svi_result(16),
    quotesAdmitArbitrage: w.pc_svi_result(17) === 1,
  };
  if (input.expiry !== undefined) slice.expiry = input.expiry;
  if (slice.quotesAdmitArbitrage) {
    slice.message =
      `${label}: these quotes imply a negative density near k = ` +
      `${slice.unconstrained.minDensityAt.toFixed(2)}; the arbitrage-free fit is ` +
      `${(slice.arbitrageCostVol * 100).toFixed(2)} vol points RMSE further from them`;
  }
  return slice;
}

/** Total implied variance on a fitted slice at a log-moneyness. */
export function totalVariance(exports: PricingExports, params: SviParams, k: number): number {
  return exports.pc_svi_eval(params.a, params.b, params.rho, params.m, params.sigma, k, 0);
}

/** Implied vol on a fitted slice at a strike. */
export function sviVol(
  exports: PricingExports,
  slice: SviSlice,
  strike: number,
  forward: number,
): number {
  const k = exports.pc_log_moneyness(strike, forward);
  return Math.sqrt(totalVariance(exports, slice.fit.params, k) / slice.time);
}

export interface CalendarViolation {
  near: string;
  far: string;
  /** Log-moneyness where total variance falls the most. */
  k: number;
  /** How far it falls, in total variance. */
  decrease: number;
  message: string;
}

export interface SviSurface {
  slices: SviSlice[];
  calendar: CalendarViolation[];
  /** Every slice free of butterfly arbitrage *and* no calendar violation. */
  arbitrageFree: boolean;
}

/** How far each side of the quoted range the calendar is checked, in k. */
export const CALENDAR_MARGIN = 1;
export const CALENDAR_POINTS = 201;

/**
 * Fit every expiry and check each neighbouring pair for a calendar violation.
 *
 * The check range is the union of the two slices' quoted log-moneyness,
 * widened as the butterfly check is: a calendar violation confined to a wing
 * nobody quoted is still one.
 */
export function fitSviSurface(
  exports: PricingExports,
  expiries: readonly ExpiryQuotes[],
): SviSurface {
  const sorted = [...expiries].sort((a, b) => a.time - b.time);
  const slices = sorted.map((expiry) => fitSviSlice(exports, expiry));
  const calendar: CalendarViolation[] = [];

  for (let i = 1; i < slices.length; i++) {
    const near = slices[i - 1]!;
    const far = slices[i]!;
    const ks = [sorted[i - 1]!, sorted[i]!].flatMap((e) =>
      e.quotes.map((q) => exports.pc_log_moneyness(q.strike, e.forward)),
    );
    const lo = Math.min(...ks) - CALENDAR_MARGIN;
    const hi = Math.max(...ks) + CALENDAR_MARGIN;
    let worst = 0;
    let at: number | undefined;
    for (let j = 0; j < CALENDAR_POINTS; j++) {
      const k = lo + ((hi - lo) * j) / (CALENDAR_POINTS - 1);
      const decrease =
        totalVariance(exports, near.fit.params, k) - totalVariance(exports, far.fit.params, k);
      if (decrease > worst) {
        worst = decrease;
        at = k;
      }
    }
    if (at !== undefined) {
      const nearLabel = near.expiry ?? `${(near.time * 365).toFixed(0)}d`;
      const farLabel = far.expiry ?? `${(far.time * 365).toFixed(0)}d`;
      calendar.push({
        near: nearLabel,
        far: farLabel,
        k: at,
        decrease: worst,
        message:
          `${farLabel} carries less total variance than ${nearLabel} at k = ${at.toFixed(2)}: ` +
          'a calendar spread there is worth less than nothing',
      });
    }
  }

  return {
    slices,
    calendar,
    arbitrageFree: calendar.length === 0 && slices.every((s) => s.fit.minDensity >= 0),
  };
}
