import { beforeAll, describe, expect, it } from 'vitest';
import type { PricingExports } from '../src/module.js';
import {
  NotEnoughQuotes,
  fitSviSlice,
  fitSviSurface,
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
