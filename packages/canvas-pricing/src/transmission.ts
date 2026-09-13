/**
 * Cross-asset transmission: a rate shock reaching an options book (PRD 5.3).
 *
 * "A rate shock node emits a `curve` output that any equity, credit, or options
 * node can consume, applying its own sensitivity model (equity:
 * duration-of-equity via a DCF sensitivity or an empirical beta-to-rates;
 * options: direct rho plus vol-of-rates spillover)."
 *
 * Three channels, and they are not equally trustworthy:
 *
 *  1. **Direct rho.** The option discounts at the curve, so a shocked curve
 *     changes the price with no model in between. This one is arithmetic.
 *  2. **Spot, via beta-to-rates.** An empirical regression of the underlier's
 *     returns on rate changes. This one is an estimate and can be a bad one.
 *  3. **Vol, via the rate-shock-to-vol relationship.** Same, and usually worse.
 *
 * The PRD is specific about how to handle (2) and (3): "the node shows
 * R-squared per name; NVDA's is 0.31 over the trailing two years, AVGO's is
 * 0.11, and the node says so plainly rather than pretending both are reliable."
 * So the betas here are *estimated from observations* rather than passed in as
 * numbers, and every estimate carries its R², its standard error and its sample
 * size. Section 9 sets the threshold: a mapping whose R² falls below 0.2 is an
 * assumption, and gets enumerated as one.
 */

import type { Curve } from './curve.js';
import type { Market } from './grid.js';

/** PRD 9: below this, a mapping is an assumption rather than a measurement. */
export const WEAK_FIT_R_SQUARED = 0.2;

/** A fitted univariate relationship, with everything needed to distrust it. */
export interface Estimate {
  /** Units of `y` per unit of `x`. */
  slope: number;
  intercept: number;
  rSquared: number;
  /** Standard error of the slope. */
  standardError: number;
  observations: number;
  /** True when R² is below the threshold the PRD sets for an assumption. */
  weak: boolean;
}

/**
 * Ordinary least squares on paired observations.
 *
 * Returns `undefined` rather than a slope when there is nothing to fit: fewer
 * than three points, or an `x` that never moves. A regression on two points has
 * an R² of exactly 1 and means nothing, and reporting that would be worse than
 * reporting nothing.
 */
export function estimate(x: readonly number[], y: readonly number[]): Estimate | undefined {
  const n = Math.min(x.length, y.length);
  if (n < 3) return undefined;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += x[i] as number;
    sumY += y[i] as number;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (x[i] as number) - meanX;
    const dy = (y[i] as number) - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return undefined;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const residual = syy - slope * sxy;
  // A perfectly flat y gives 0/0; there is no explained variance because there
  // was no variance, and an R² of 1 would be a lie about a constant.
  const rSquared = syy === 0 ? 0 : Math.max(0, 1 - residual / syy);
  const standardError = Math.sqrt(Math.max(0, residual) / Math.max(1, n - 2) / sxx);

  return {
    slope,
    intercept,
    rSquared,
    standardError,
    observations: n,
    weak: rSquared < WEAK_FIT_R_SQUARED,
  };
}

/** Observations for one underlier, over one window. */
export interface SensitivityInput {
  underlier: string;
  /** Daily change in the reference rate, in basis points. */
  rateChangesBps: readonly number[];
  /** Matching underlier returns, in decimals. */
  returns: readonly number[];
  /** Matching changes in implied vol, in vol points. */
  volChanges?: readonly number[];
  /** The window these observations cover, for the audit trail. */
  window: readonly [string, string];
}

/** What a rate move does to one name, and how much to believe it. */
export interface Sensitivity {
  underlier: string;
  window: readonly [string, string];
  /** Return per basis point of rate move. */
  spot: Estimate;
  /** Vol points per basis point. Absent when no vol history was supplied. */
  vol?: Estimate;
}

export function fitSensitivity(input: SensitivityInput): Sensitivity | undefined {
  const spot = estimate(input.rateChangesBps, input.returns);
  if (!spot) return undefined;
  const vol = input.volChanges ? estimate(input.rateChangesBps, input.volChanges) : undefined;
  return {
    underlier: input.underlier,
    window: input.window,
    spot,
    ...(vol !== undefined ? { vol } : {}),
  };
}

/** The market a shock produces, and an account of how it got there. */
export interface Transmission {
  /** The market to reprice against: shocked rate, shocked spot. */
  market: Market;
  /** Vol points to add to every leg, for the grid's vol axis. */
  volShiftPoints: number;
  /** The rate move at the pricing tenor, in basis points. */
  rateMoveBps: number;
  /** The spot move the beta implies, as a fraction. */
  spotMovePct: number;
  /**
   * One line per channel, naming its estimation quality.
   *
   * PRD 9 asks an assumption audit to "enumerate every mapping whose estimation
   * R-squared falls below 0.2". These are those lines, written where the
   * analyst reads them rather than only where an agent traverses them.
   */
  assumptions: string[];
}

export interface TransmitOptions {
  /** Where on the curve the option's discount rate is read. Defaults to 1y. */
  pricingTenor?: number;
  /**
   * Rate at the pricing tenor before the shock. Supply it when the market's
   * `rate` came from somewhere other than this curve, so the direct-rho channel
   * measures a move rather than a level difference.
   */
  baseRate?: number;
}

/**
 * Applies a curve shock to an options market.
 *
 * Takes both curves rather than a shock description, because the transmission
 * is driven by what the curve did at the tenor the option prices off — which is
 * the only thing a nominal shock size and a hand-drawn shape have in common.
 *
 * The direct channel is exact: the option discounts at the curve, so the
 * shocked rate is simply the shocked curve's rate. The other two are estimates,
 * and they are reported as such.
 */
export function transmit(
  market: Market,
  base: Curve,
  shocked: Curve,
  sensitivity: Sensitivity | undefined,
  options: TransmitOptions = {},
): Transmission {
  const tenor = options.pricingTenor ?? 1;
  // Read what the curve actually did rather than what the shock was called.
  // A parallel 50bp and a steepener that happens to move the one-year point by
  // 50bp transmit identically to a one-year option, and a shape the analyst
  // drew with the pen has no nominal size at all.
  const rateMoveBps = (shocked.zero(tenor) - base.zero(tenor)) * 10_000;
  const assumptions: string[] = [];

  // Channel one: direct rho. No model, no estimate, no caveat.
  const rate = (options.baseRate ?? market.rate) + rateMoveBps / 10_000;

  // Channel two: spot, via the estimated beta.
  let spotMovePct = 0;
  if (sensitivity) {
    spotMovePct = sensitivity.spot.slope * rateMoveBps;
    assumptions.push(describe(sensitivity.underlier, 'spot', sensitivity.spot, sensitivity.window));
  } else {
    assumptions.push(
      'no beta-to-rates was estimated, so the shock moves the discount rate and nothing else — ' +
        'the spot channel is switched off, not set to zero by assumption',
    );
  }

  // Channel three: vol spillover.
  let volShiftPoints = 0;
  if (sensitivity?.vol) {
    volShiftPoints = sensitivity.vol.slope * rateMoveBps;
    assumptions.push(describe(sensitivity.underlier, 'vol', sensitivity.vol, sensitivity.window));
  }

  return {
    market: { ...market, rate, spot: market.spot * (1 + spotMovePct) },
    volShiftPoints,
    rateMoveBps,
    spotMovePct,
    assumptions,
  };
}

/** One channel's line in the assumption list. */
function describe(
  underlier: string,
  channel: 'spot' | 'vol',
  fit: Estimate,
  window: readonly [string, string],
): string {
  const quality = fit.weak
    ? `R² ${fit.rSquared.toFixed(2)} — below ${WEAK_FIT_R_SQUARED}, treat as an assumption`
    : `R² ${fit.rSquared.toFixed(2)}`;
  const per100 =
    channel === 'spot'
      ? `${(fit.slope * 100 * 100).toFixed(2)}% per 100bp`
      : `${(fit.slope * 100).toFixed(2)} vol points per 100bp`;
  return (
    `${underlier} ${channel}-to-rates: ${per100}, ${quality}, ` +
    `se ${(fit.standardError * 100 * 100).toFixed(2)} over ${fit.observations} days ` +
    `(${window[0]} to ${window[1]})`
  );
}

/**
 * The assumption audit for a whole book: every weak mapping, named.
 *
 * Separate from the per-transmission lines because PRD 9's audit is a traversal
 * over the canvas, and an analyst looking at a scenario wants the short list of
 * what not to believe rather than the full account.
 */
export function weakMappings(sensitivities: readonly Sensitivity[]): string[] {
  const weak: string[] = [];
  for (const s of sensitivities) {
    if (s.spot.weak) {
      weak.push(`${s.underlier}: spot-to-rates R² ${s.spot.rSquared.toFixed(2)}`);
    }
    if (s.vol?.weak) {
      weak.push(`${s.underlier}: vol-to-rates R² ${s.vol.rSquared.toFixed(2)}`);
    }
  }
  return weak;
}
