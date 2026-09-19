/**
 * Heston on the canvas: the smile, and the fit behind it (PRD 5.8).
 *
 * > Calibration: parameters either user-set, fit to history over a chosen
 * > window, or fit to the current option surface (for Heston, via differential
 * > evolution on the surface fit residual).
 *
 * Two operations with two very different costs, and the difference is the whole
 * shape of this file.
 *
 * **Pricing is interactive.** A Heston price is about 37µs native and roughly
 * twice that through WASM, so a fifty-point smile is a couple of milliseconds
 * and a node can redraw it while a parameter slider moves.
 *
 * **Calibration is not.** Differential evolution at the default budget is tens
 * of thousands of surface evaluations — seconds of solid arithmetic on one
 * thread, with no yield point in it. Run on the main thread it freezes the tab
 * for the duration, and PRD 7.1's whole argument about perceived latency is
 * that Picasso does not do that. So `calibrate` states its cost before running
 * anything and refuses past a ceiling, the same way the Monte Carlo surface
 * does, and the honest place to run a full fit is a worker or the server.
 *
 * The conditioning report is passed through rather than hidden. Past
 * `kappa theta / sigma^2` of about 1e7 the closed form is losing digits to
 * cancellation — measured, not feared — and a fit that lands there is reporting
 * parameters read off a price that was not accurate enough to read them from.
 */

import { readFloats, type PricingExports } from './module.js';
import type { OptionKind } from './pricing.js';

export interface HestonParams {
  /** Initial instantaneous variance. */
  v0: number;
  /** Long-run variance. */
  theta: number;
  /** Mean reversion speed. */
  kappa: number;
  /** Volatility of variance. */
  sigma: number;
  /** Spot-variance correlation. Negative is the equity case, and is the skew. */
  rho: number;
}

export interface HestonMarket {
  spot: number;
  rate: number;
  dividend: number;
}

export interface HestonOption {
  strike: number;
  /** Years to expiry. */
  time: number;
  kind: OptionKind;
}

/** A European option under Heston, by the Lewis integral. */
export function hestonPrice(
  exports: PricingExports,
  params: HestonParams,
  market: HestonMarket,
  option: HestonOption,
): number {
  return exports.pc_heston_price(
    market.spot,
    option.strike,
    option.time,
    market.rate,
    market.dividend,
    option.kind === 'call' ? 1 : 0,
    params.v0,
    params.theta,
    params.kappa,
    params.sigma,
    params.rho,
  );
}

/**
 * The Black-Scholes volatility that reproduces the Heston price.
 *
 * NaN where the inversion carries no information — deep in the money near
 * expiry, where vega collapses and every vol in a wide band reproduces the
 * price to the last bit of a double. Passed through as NaN rather than
 * substituted, so a caller plotting a smile leaves a gap instead of drawing a
 * point nobody can invert.
 */
export function hestonImpliedVol(
  exports: PricingExports,
  params: HestonParams,
  market: HestonMarket,
  option: HestonOption,
): number {
  return exports.pc_heston_iv(
    market.spot,
    option.strike,
    option.time,
    market.rate,
    market.dividend,
    option.kind === 'call' ? 1 : 0,
    params.v0,
    params.theta,
    params.kappa,
    params.sigma,
    params.rho,
  );
}

/** `kappa theta / sigma^2`, and whether the closed form is still sound there. */
export function conditioning(
  exports: PricingExports,
  params: HestonParams,
): { value: number; limit: number; sound: boolean } {
  const value = exports.pc_heston_conditioning(
    params.v0,
    params.theta,
    params.kappa,
    params.sigma,
    params.rho,
  );
  const limit = exports.pc_heston_conditioning_limit();
  return { value, limit, sound: value <= limit };
}

/** `2 kappa theta - sigma^2`. Non-negative means the variance stays positive. */
export function feller(params: HestonParams): number {
  return 2 * params.kappa * params.theta - params.sigma * params.sigma;
}

/**
 * A whole smile in one pass, for a chart.
 *
 * Returns implied vols in strike order, with NaN left where the inversion
 * carries no information.
 */
export function smile(
  exports: PricingExports,
  params: HestonParams,
  market: HestonMarket,
  strikes: readonly number[],
  time: number,
): number[] {
  return strikes.map((strike) =>
    hestonImpliedVol(exports, params, market, {
      strike,
      time,
      // Out-of-the-money on each side, which is what a quoted smile is made of
      // and where the inversion is best conditioned.
      kind: strike >= market.spot ? 'call' : 'put',
    }),
  );
}

export interface SurfaceQuote extends HestonOption {
  /** The market's implied volatility. */
  vol: number;
  /** Relative weight: vega, open interest, or one. */
  weight?: number;
}

export type HestonResidual = 'impliedVol' | 'price';

export interface CalibrationSpec {
  market: HestonMarket;
  quotes: readonly SurfaceQuote[];
  /**
   * Defaults to `impliedVol`, and the default matters. A price residual is
   * dominated by the most expensive quotes — the long-dated at-the-money ones —
   * so it lands the wings wherever they fall, and the wings are the entire
   * reason anybody fits Heston rather than Black-Scholes.
   */
  residual?: HestonResidual;
  population?: number;
  generations?: number;
  seed?: number;
  /**
   * Largest fit this caller will accept, in surface evaluations
   * (`population * (generations + 1) * quotes`). Defaults to
   * `DEFAULT_FIT_CEILING`.
   */
  maxEvaluations?: number;
}

export interface HestonFit {
  params: HestonParams;
  /** Weighted RMSE, in the residual's own units. */
  rmse: number;
  /** Largest single-quote residual, and which quote it was. */
  worst: number;
  worstQuote: number;
  /** Quotes the pricer could not produce a usable residual for. */
  skipped: number;
  /**
   * Spread of the final population's scores.
   *
   * Large means the search had not converged, whatever the best score says.
   * Reported because a fit that stopped with its population scattered is a
   * different claim from one that stopped because everything agreed.
   */
  scoreSpread: number;
  /** `2 kappa theta - sigma^2` at the fit. */
  feller: number;
  /** `kappa theta / sigma^2` at the fit. */
  conditioning: number;
  /** False when the fit landed where the closed form loses digits. */
  soundlyConditioned: boolean;
  evaluations: number;
}

/**
 * Surface evaluations a browser will attempt without being told otherwise.
 *
 * A Heston price is roughly 75µs through WASM, so 200,000 evaluations of a
 * 15-quote surface is on the order of a minute. This ceiling is about a second
 * of arithmetic, which is already past what belongs on the main thread and is
 * set as something to refuse at rather than to aim for.
 */
export const DEFAULT_FIT_CEILING = 20_000;

export class CalibrationTooLarge extends Error {
  constructor(
    readonly evaluations: number,
    readonly ceiling: number,
  ) {
    super(
      `this fit is ${evaluations.toLocaleString('en-US')} surface evaluations, past the ${ceiling.toLocaleString('en-US')} ceiling. ` +
        'Shrink the population or the generations for a local preview, run it in a worker, or send it to the server.',
    );
    this.name = 'CalibrationTooLarge';
  }
}

export class EmptySurface extends Error {
  constructor() {
    super('a calibration needs at least one quote');
    this.name = 'EmptySurface';
  }
}

/** `population * (generations + 1) * quotes`: what the fit will actually cost. */
export function estimateFitCost(spec: CalibrationSpec): number {
  const population = spec.population ?? 40;
  const generations = spec.generations ?? 60;
  return population * (generations + 1) * spec.quotes.length;
}

export function calibrateHeston(exports: PricingExports, spec: CalibrationSpec): HestonFit {
  if (spec.quotes.length === 0) throw new EmptySurface();

  const ceiling = spec.maxEvaluations ?? DEFAULT_FIT_CEILING;
  const cost = estimateFitCost(spec);
  if (cost > ceiling) throw new CalibrationTooLarge(cost, ceiling);

  exports.pc_heston_surface_reset();
  for (const quote of spec.quotes) {
    exports.pc_heston_surface_add(
      quote.strike,
      quote.time,
      quote.kind === 'call' ? 1 : 0,
      quote.vol,
      quote.weight ?? 1,
    );
  }

  const count = exports.pc_heston_calibrate(
    spec.market.spot,
    spec.market.rate,
    spec.market.dividend,
    spec.residual === 'price' ? 1 : 0,
    spec.population ?? 40,
    spec.generations ?? 60,
    spec.seed ?? 0x5eed0de,
  );
  if (count < 0) throw new EmptySurface();

  const fit = readFloats(exports.memory, exports.pc_heston_fit(), 11);
  const params: HestonParams = {
    v0: fit[0] as number,
    theta: fit[1] as number,
    kappa: fit[2] as number,
    sigma: fit[3] as number,
    rho: fit[4] as number,
  };
  const limit = exports.pc_heston_conditioning_limit();
  const conditioningValue = exports.pc_heston_conditioning(
    params.v0,
    params.theta,
    params.kappa,
    params.sigma,
    params.rho,
  );

  return {
    params,
    rmse: fit[5] as number,
    worst: fit[6] as number,
    worstQuote: fit[7] as number,
    skipped: fit[8] as number,
    scoreSpread: fit[9] as number,
    feller: fit[10] as number,
    conditioning: conditioningValue,
    soundlyConditioned: conditioningValue <= limit,
    evaluations: cost,
  };
}
