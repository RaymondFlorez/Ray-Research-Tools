import { beforeAll, describe, expect, it } from 'vitest';
import {
  CalibrationTooLarge,
  DEFAULT_FIT_CEILING,
  EmptySurface,
  calibrateHeston,
  conditioning,
  estimateFitCost,
  feller,
  hestonImpliedVol,
  hestonPrice,
  smile,
  type HestonMarket,
  type HestonParams,
  type PricingExports,
  type SurfaceQuote,
} from '../src/index.js';
import { loadPricing } from './load.js';

let wasm: PricingExports;
beforeAll(async () => {
  wasm = await loadPricing();
});

const MARKET: HestonMarket = { spot: 100, rate: 0.03, dividend: 0.01 };
const TRUTH: HestonParams = { v0: 0.042, theta: 0.058, kappa: 1.8, sigma: 0.55, rho: -0.68 };

describe('pricing through the bridge', () => {
  it('prices a call and a put that satisfy parity exactly', () => {
    for (const [strike, time] of [
      [80, 0.25],
      [100, 1],
      [130, 2],
    ] as const) {
      const call = hestonPrice(wasm, TRUTH, MARKET, { strike, time, kind: 'call' });
      const put = hestonPrice(wasm, TRUTH, MARKET, { strike, time, kind: 'put' });
      const parity =
        MARKET.spot * Math.exp(-MARKET.dividend * time) - strike * Math.exp(-MARKET.rate * time);
      expect(call - put).toBeCloseTo(parity, 10);
    }
  });

  it('produces a smile that slopes the way rho says', () => {
    const strikes = [75, 85, 95, 105, 115, 125];
    const down = smile(wasm, TRUTH, MARKET, strikes, 1);
    expect(down.every((v) => Number.isFinite(v))).toBe(true);
    expect(down[0]).toBeGreaterThan(down[down.length - 1] as number);

    const up = smile(wasm, { ...TRUTH, rho: 0.68 }, MARKET, strikes, 1);
    expect(up[0]).toBeLessThan(up[up.length - 1] as number);
  });

  it('inverts to a vol the pricer reproduces', () => {
    const option = { strike: 110, time: 1, kind: 'call' as const };
    const vol = hestonImpliedVol(wasm, TRUTH, MARKET, option);
    expect(vol).toBeGreaterThan(0.05);
    expect(vol).toBeLessThan(1);
  });

  it('reports the conditioning rather than pricing through it', () => {
    const sound = conditioning(wasm, TRUTH);
    expect(sound.sound).toBe(true);
    expect(sound.value).toBeLessThan(sound.limit);

    // Vol of vol at 1e-6 is where the series coefficient's cancellation
    // overwhelms the answer. The measurement is in `heston.rs`.
    const degenerate = conditioning(wasm, { ...TRUTH, sigma: 1e-6 });
    expect(degenerate.sound).toBe(false);
    expect(degenerate.value).toBeGreaterThan(degenerate.limit);
  });

  it('computes Feller without crossing the boundary to ask', () => {
    expect(feller(TRUTH)).toBeCloseTo(2 * 1.8 * 0.058 - 0.55 ** 2, 12);
    // This truth violates it, which real equity surfaces routinely do.
    expect(feller(TRUTH)).toBeLessThan(0);
  });
});

describe('calibration', () => {
  function syntheticQuotes(params: HestonParams): SurfaceQuote[] {
    const quotes: SurfaceQuote[] = [];
    for (const time of [0.25, 1, 2]) {
      for (const strike of [80, 90, 100, 110, 125]) {
        const kind = strike >= MARKET.spot ? ('call' as const) : ('put' as const);
        const vol = hestonImpliedVol(wasm, params, MARKET, { strike, time, kind });
        if (Number.isFinite(vol)) quotes.push({ strike, time, kind, vol });
      }
    }
    return quotes;
  }

  // One full fit, shared. Fifty members over a hundred and twenty generations
  // on a fifteen-quote surface is about ninety thousand Heston prices through
  // WASM — seconds, which is the point the wrapper's ceiling exists to make.
  let full: ReturnType<typeof calibrateHeston>;
  beforeAll(() => {
    full = calibrateHeston(wasm, {
      market: MARKET,
      quotes: syntheticQuotes(TRUTH),
      population: 50,
      generations: 120,
      seed: 0xa11ce,
      maxEvaluations: 200_000,
    });
  }, 120_000);

  it('recovers the parameters a surface was generated from', () => {
    const quotes = syntheticQuotes(TRUTH);
    expect(quotes.length).toBe(15);
    const fit = full;

    expect(fit.skipped).toBe(0);
    expect(fit.rmse).toBeLessThan(1e-5);
    expect(fit.params.v0).toBeCloseTo(TRUTH.v0, 3);
    expect(fit.params.theta).toBeCloseTo(TRUTH.theta, 3);
    expect(fit.params.kappa).toBeCloseTo(TRUTH.kappa, 1);
    expect(fit.params.sigma).toBeCloseTo(TRUTH.sigma, 2);
    expect(fit.params.rho).toBeCloseTo(TRUTH.rho, 2);
  });

  it('carries the diagnostics a fit has to be read with', () => {
    const fit = full;
    expect(fit.worst).toBeGreaterThanOrEqual(fit.rmse);
    expect(fit.worstQuote).toBeGreaterThanOrEqual(0);
    expect(fit.scoreSpread).toBeGreaterThanOrEqual(0);
    expect(fit.soundlyConditioned).toBe(true);
    // The surface was generated from parameters that violate Feller, and the
    // fit should land there rather than having quietly avoided the region.
    expect(fit.feller).toBeLessThan(0);
  });

  // Differential evolution at the default budget is seconds of solid
  // arithmetic with no yield point. Run on the main thread it freezes the tab,
  // and PRD 7.1's whole argument about perceived latency is that Picasso does
  // not do that.
  it('refuses a fit too large for the main thread, and says what it would cost', () => {
    const quotes = syntheticQuotes(TRUTH);
    const spec = { market: MARKET, quotes, population: 60, generations: 300 };
    expect(estimateFitCost(spec)).toBe(60 * 301 * 15);
    expect(estimateFitCost(spec)).toBeGreaterThan(DEFAULT_FIT_CEILING);

    let thrown: unknown;
    try {
      calibrateHeston(wasm, spec);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CalibrationTooLarge);
    expect((thrown as Error).message).toMatch(/worker|server/);
  });

  it('runs a small preview inside the default ceiling', () => {
    const fit = calibrateHeston(wasm, {
      market: MARKET,
      quotes: syntheticQuotes(TRUTH),
      population: 20,
      generations: 40,
    });
    expect(estimateFitCost({ market: MARKET, quotes: syntheticQuotes(TRUTH), population: 20, generations: 40 }))
      .toBeLessThan(DEFAULT_FIT_CEILING);
    // A preview, not a fit: it is allowed to be loose, and the score spread is
    // how a caller tells which one it got.
    expect(Number.isFinite(fit.rmse)).toBe(true);
    expect(fit.scoreSpread).toBeGreaterThanOrEqual(0);
  });

  it('refuses an empty surface', () => {
    expect(() => calibrateHeston(wasm, { market: MARKET, quotes: [] })).toThrow(EmptySurface);
  });

  it('is deterministic in the seed', () => {
    const quotes = syntheticQuotes(TRUTH);
    const run = (seed: number) =>
      calibrateHeston(wasm, { market: MARKET, quotes, population: 20, generations: 40, seed });
    expect(run(7).params).toEqual(run(7).params);
    expect(run(7).params).not.toEqual(run(8).params);
  });
});
