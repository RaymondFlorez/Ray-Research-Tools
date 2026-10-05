import { describe, expect, it } from 'vitest';
import { factorAttribution, rollingAttribution } from '../src/attribution.js';

function uniform(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normals(n: number, seed: number): number[] {
  const r = uniform(seed);
  const out: number[] = [];
  while (out.length < n) {
    const u = r() || 1e-12;
    out.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()));
  }
  return out;
}

const T = 500;
const market = normals(T, 1).map((x) => 0.0004 + 0.01 * x);
const idio = normals(T, 2).map((x) => 0.002 * x);
const ALPHA = 0.0002;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe('static attribution', () => {
  // A constant beta of 0.8: the case a single regression is right about.
  const steady = market.map((m, t) => ALPHA + 0.8 * m + idio[t]!);

  it('decomposes summed returns exactly, with nothing in a residual', () => {
    const a = factorAttribution(steady, [{ name: 'mkt', values: market }]);
    expect(Math.abs(a.residual)).toBeLessThan(1e-12);
    expect(sum(a.lines.map((l) => l.contribution))).toBeCloseTo(a.additiveTotal, 12);
    const mkt = a.lines.find((l) => l.source === 'mkt')!.contribution;
    expect(mkt).toBeCloseTo(0.8 * sum(market), 2);
  });

  it('reports compounding as its own line rather than rescaling the factors to fit', () => {
    const a = factorAttribution(steady, [{ name: 'mkt', values: market }]);
    expect(a.compounding).toBeCloseTo(a.compoundedTotal - a.additiveTotal, 15);
    expect(a.additiveTotal + a.compounding).toBeCloseTo(a.compoundedTotal, 15);
    expect(Math.abs(a.compounding)).toBeGreaterThan(0.001);
  });
});

describe('a strategy that flips its market exposure halfway', () => {
  // Long the market for 250 bars, short it for 250. True market contribution
  // 0.345, alpha 0.100, idiosyncratic 0.067.
  const beta = (t: number) => (t < T / 2 ? 1 : -1);
  const flipping = market.map((m, t) => ALPHA + beta(t) * m + idio[t]!);
  const trueMarket = sum(market.map((m, t) => beta(t) * m));

  it('is mostly alpha to a single regression, which is wrong', () => {
    expect(trueMarket).toBeCloseTo(0.3446, 3);
    expect(sum(idio)).toBeCloseTo(0.067, 3);
    const a = factorAttribution(flipping, [{ name: 'mkt', values: market }]);
    // The average beta is near zero, so 0.34 of market P&L lands in alpha.
    expect(a.lines.find((l) => l.source === 'alpha')!.contribution).toBeCloseTo(0.5213, 3);
    expect(a.lines.find((l) => l.source === 'mkt')!.contribution).toBeCloseTo(-0.0096, 3);
    expect(Math.abs(a.residual)).toBeLessThan(1e-12);
  });

  it('is mostly market to an ex-ante rolling fit, which lags the flip and says so', () => {
    const a = rollingAttribution(flipping, [{ name: 'mkt', values: market }], 60);
    // Truth over the bars it attributes (t >= 60).
    expect(sum(market.slice(60).map((m, i) => beta(i + 60) * m))).toBeCloseTo(0.1425, 4);
    expect(ALPHA * (T - 60)).toBeCloseTo(0.088, 12);
    expect(a.lines.find((l) => l.source === 'mkt')!.contribution).toBeCloseTo(0.117, 3);
    expect(a.lines.find((l) => l.source === 'alpha')!.contribution).toBeCloseTo(0.1192, 3);
    // The first window and the stale betas after the flip are in the residual,
    // not folded into alpha.
    expect(a.residual).toBeCloseTo(0.2755, 3);
  });

  it('never uses a bar to estimate the betas that attribute it', () => {
    // Changing the last bar's return changes nothing about its own betas, so
    // its attribution moves by exactly its factor contribution's absence: the
    // residual takes the whole change.
    const base = rollingAttribution(flipping, [{ name: 'mkt', values: market }], 60);
    const bumped = [...flipping];
    bumped[T - 1]! += 0.05;
    const after = rollingAttribution(bumped, [{ name: 'mkt', values: market }], 60);
    expect(after.residual - base.residual).toBeCloseTo(0.05, 12);
    for (const [i, line] of after.lines.entries()) expect(line.contribution).toBeCloseTo(base.lines[i]!.contribution, 12);
  });
});
