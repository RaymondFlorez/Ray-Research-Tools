import { beforeAll, describe, expect, it } from 'vitest';
import type { PricingExports } from '../src/module.js';
import { GridPricer } from '../src/grid.js';
import { atTheMoney, createStrategyNode, evaluateStrategy } from '../src/strategy.js';
import {
  NotEnoughQuotes,
  OutsideSurface,
  fitSviSlice,
  fitSviSurface,
  forwardPrice,
  legsOnSurface,
  surfaceVol,
  sviVol,
  type ExpiryQuotes,
  type SviParams,
} from '../src/svi.js';
import { loadPricing } from './load.js';

let wasm: PricingExports;

beforeAll(async () => {
  wasm = await loadPricing();
});

/** Total variance of a raw SVI slice, for building fixtures. */
function w(p: SviParams, k: number): number {
  const x = k - p.m;
  return p.a + p.b * (p.rho * x + Math.sqrt(x * x + p.sigma * p.sigma));
}

/** Quotes read off a known slice, at strikes around a forward of 100. */
function quotesFrom(p: SviParams, time: number, lo: number, hi: number, n: number, expiry?: string): ExpiryQuotes {
  const quotes = Array.from({ length: n }, (_, i) => {
    const k = lo + ((hi - lo) * i) / (n - 1);
    return { strike: 100 * Math.exp(k), vol: Math.sqrt(w(p, k) / time) };
  });
  return { time, forward: 100, quotes, ...(expiry ? { expiry } : {}) };
}

const CLEAN: SviParams = { a: 0.02, b: 0.12, rho: -0.55, m: 0.05, sigma: 0.25 };
/** Gatheral and Jacquier's counterexample, due to Axel Vogt. */
const VOGT: SviParams = { a: -0.041, b: 0.1331, rho: 0.306, m: 0.3586, sigma: 0.4153 };

describe('one expiry', () => {
  it('recovers a clean smile and does not flag it', () => {
    const input = quotesFrom(CLEAN, 0.5, -0.6, 0.4, 15, 'Jun');
    const slice = fitSviSlice(wasm, input);
    expect(slice.fit.rmseVol).toBeLessThan(0.001);
    expect(slice.fit.minDensity).toBeGreaterThan(0);
    expect(slice.quotesAdmitArbitrage).toBe(false);
    expect(slice.message).toBeUndefined();
    for (const quote of input.quotes) {
      expect(sviVol(wasm, slice, quote.strike, 100)).toBeCloseTo(quote.vol, 4);
    }
  });

  it("flags quotes that cannot be fitted without arbitrage, and says what it cost", () => {
    const slice = fitSviSlice(wasm, quotesFrom(VOGT, 1, -1, 1, 21, 'Dec'));
    // Unconstrained, SVI reproduces its own slice and its negative density.
    expect(slice.unconstrained.minDensity).toBeLessThan(0);
    // Constrained, the density is non-negative and the fit is 0.44 vol points
    // further from the quotes. That number is the information.
    expect(slice.fit.minDensity).toBeGreaterThan(0);
    expect(slice.arbitrageCostVol).toBeCloseTo(0.0044, 3);
    expect(slice.quotesAdmitArbitrage).toBe(true);
    expect(slice.message).toContain('Dec');
    expect(slice.message).toContain('0.44 vol points');
  });

  it('refuses to fit five parameters to four quotes', () => {
    expect(() => fitSviSlice(wasm, quotesFrom(CLEAN, 0.5, -0.2, 0.2, 4, 'Jun'))).toThrow(
      NotEnoughQuotes,
    );
  });
});

describe('the surface', () => {
  it('passes a term structure whose variance grows with maturity', () => {
    const near = quotesFrom(CLEAN, 0.25, -0.5, 0.3, 13, 'Mar');
    const far = quotesFrom({ ...CLEAN, a: CLEAN.a + 0.02, b: CLEAN.b * 1.3 }, 0.75, -0.6, 0.4, 13, 'Sep');
    const surface = fitSviSurface(wasm, [far, near]);
    expect(surface.slices.map((s) => s.expiry)).toEqual(['Mar', 'Sep']);
    expect(surface.calendar).toEqual([]);
    expect(surface.arbitrageFree).toBe(true);
  });

  it('reports a calendar violation where total variance falls, and names the pair', () => {
    // The far expiry carries less total variance than the near one across
    // the put wing: a calendar spread there is worth less than nothing.
    const near = quotesFrom({ ...CLEAN, a: 0.05 }, 0.25, -0.5, 0.3, 13, 'Mar');
    const far = quotesFrom(CLEAN, 0.75, -0.6, 0.4, 13, 'Sep');
    const surface = fitSviSurface(wasm, [near, far]);
    expect(surface.calendar).toHaveLength(1);
    const [violation] = surface.calendar;
    expect(violation!.near).toBe('Mar');
    expect(violation!.far).toBe('Sep');
    expect(violation!.decrease).toBeGreaterThan(0);
    expect(violation!.message).toContain('less total variance');
    expect(surface.arbitrageFree).toBe(false);
  });
});

describe('pricing off the surface', () => {
  // Zero carry, so every forward is the spot and the fixtures' strikes line up.
  const market = { spot: 100, rate: 0, dividend: 0 };
  const NEAR: SviParams = CLEAN;
  const FAR: SviParams = { ...CLEAN, a: CLEAN.a + 0.02, b: CLEAN.b * 1.3 };
  let surface: ReturnType<typeof fitSviSurface>;

  beforeAll(() => {
    surface = fitSviSurface(wasm, [
      quotesFrom(NEAR, 0.25, -0.5, 0.3, 13, 'Mar'),
      quotesFrom(FAR, 0.75, -0.6, 0.4, 13, 'Sep'),
    ]);
  });

  it('reads a quoted vol back at a fitted expiry', () => {
    for (const k of [-0.4, -0.1, 0, 0.2]) {
      const quoted = Math.sqrt(w(NEAR, k) / 0.25);
      expect(surfaceVol(wasm, surface, 100 * Math.exp(k), 0.25, market)).toBeCloseTo(quoted, 3);
    }
  });

  it('interpolates total variance linearly in time between slices', () => {
    const k = -0.2;
    const strike = 100 * Math.exp(k);
    const wNear = surfaceVol(wasm, surface, strike, 0.25, market) ** 2 * 0.25;
    const wFar = surfaceVol(wasm, surface, strike, 0.75, market) ** 2 * 0.75;
    const mid = surfaceVol(wasm, surface, strike, 0.5, market) ** 2 * 0.5;
    expect(mid).toBeCloseTo((wNear + wFar) / 2, 12);
  });

  it('keeps a calendar-free surface calendar-free between its slices', () => {
    for (const k of [-0.5, -0.2, 0, 0.3]) {
      const strike = 100 * Math.exp(k);
      let previous = 0;
      for (let t = 0.05; t <= 0.75; t += 0.05) {
        const total = surfaceVol(wasm, surface, strike, t, market) ** 2 * t;
        expect(total).toBeGreaterThan(previous);
        previous = total;
      }
    }
  });

  it("carries the first slice's variance rate back towards zero time", () => {
    const strike = 90;
    expect(surfaceVol(wasm, surface, strike, 0.05, market)).toBeCloseTo(
      surfaceVol(wasm, surface, strike, 0.25, market),
      12,
    );
  });

  it('refuses a leg past the last fitted expiry', () => {
    expect(() => surfaceVol(wasm, surface, 100, 1.5, market)).toThrow(OutsideSurface);
  });

  it("places strikes against each expiry's own forward", () => {
    const carry = { spot: 100, rate: 0.05, dividend: 0.01 };
    const f = forwardPrice(wasm, 100, 0.05, 0.01, 0.75);
    expect(f).toBeCloseTo(100 * Math.exp(0.04 * 0.75), 10);
    // At-the-forward reads the slice's own at-the-money vol, whatever the carry.
    expect(surfaceVol(wasm, surface, f, 0.75, carry)).toBeCloseTo(
      surfaceVol(wasm, surface, 100, 0.75, market),
      12,
    );
  });

  it('prices a put wing richer on a skewed surface than at one flat vol', () => {
    const pricer = new GridPricer(wasm);
    const put = { strike: 80, time: 0.5, kind: 'put' as const, style: 'european' as const, quantity: 1, multiplier: 100, vol: 0 };
    const atm = surfaceVol(wasm, surface, 100, 0.5, market);
    const [onSurface] = legsOnSurface(wasm, surface, [put], market);
    expect(onSurface!.vol).toBeGreaterThan(atm);
    const point = { spotSteps: 1, spotRange: 0, volSteps: 1, volRange: 0 };
    const skewed = pricer.reprice([onSurface!], market, point).cell(0, 0).value;
    const flat = pricer.reprice([{ ...put, vol: atm }], market, point).cell(0, 0).value;
    expect(skewed).toBeGreaterThan(flat);
  });

  it('prices a StrategyNode on the surface when one is given', () => {
    const pricer = new GridPricer(wasm);
    const legs = [
      { strike: 80, time: 0.5, kind: 'put' as const, style: 'european' as const, quantity: 1, multiplier: 100, vol: 0.3 },
    ];
    const node = createStrategyNode({ id: 's', legs, market });
    const typed = evaluateStrategy(node, pricer, () => 1);
    const onSurface = evaluateStrategy(createStrategyNode({ id: 's2', legs, market }), pricer, () => 1, surface);
    expect(typed.ok && onSurface.ok).toBe(true);
    if (typed.ok && onSurface.ok) {
      expect(atTheMoney(onSurface.result).value).not.toBe(atTheMoney(typed.result).value);
    }
    const tooLong = createStrategyNode({ id: 's3', legs: [{ ...legs[0]!, time: 2 }], market });
    expect(() => evaluateStrategy(tooLong, pricer, () => 1, surface)).toThrow(OutsideSurface);
  });
});
