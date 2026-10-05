import { describe, expect, it } from 'vitest';
import { calibrateImpact, MIN_IMPACT_OBSERVATIONS, type ImpactObservation } from '../src/costs.js';

function uniform(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(r: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
}

/** Executions whose impact follows the square-root law at `k`, with 30% multiplicative noise. */
function executions(k: number, n: number, seed: number): ImpactObservation[] {
  const r = uniform(seed);
  const z = gaussian(r);
  return Array.from({ length: n }, () => {
    const shares = 10 ** (3 + 3 * r());
    const dailyVolume = 1e7;
    const volatility = 0.01 + 0.02 * r();
    const law = k * volatility * Math.sqrt(shares / dailyVolume);
    return { shares, dailyVolume, volatility, impact: law * (1 + 0.3 * z()) };
  });
}

describe('calibrateImpact', () => {
  it('recovers the coefficient the executions were generated with', () => {
    const c = calibrateImpact(executions(0.8, 500, 1));
    expect(c.observations).toBe(500);
    expect(Math.abs(c.coefficient - 0.8)).toBeLessThan(2 * c.standardError);
    expect(c.warnings).toEqual([]);
  });

  it('has a standard error that covers the truth about 95% of the time', () => {
    // An independent check on the standard error: not a formula compared to
    // itself, but the frequency with which the interval it implies contains
    // the coefficient the data were drawn from.
    let covered = 0;
    let textbook = 0;
    const runs = 400;
    for (let seed = 1; seed <= runs; seed++) {
      const rows = executions(0.8, 200, seed * 7919);
      const c = calibrateImpact(rows);
      if (Math.abs(c.coefficient - 0.8) < 1.96 * c.standardError) covered++;
      // The textbook s^2 / sum(x^2), which assumes noise that does not grow
      // with the trade. It is what the first version shipped.
      const xs = rows.map((o) => o.volatility * Math.sqrt(o.shares / o.dailyVolume));
      const sxx = xs.reduce((a, x) => a + x * x, 0);
      const sse = rows.reduce((a, o, i) => a + (o.impact - c.coefficient * xs[i]!) ** 2, 0);
      if (Math.abs(c.coefficient - 0.8) < 1.96 * Math.sqrt(sse / (rows.length - 1) / sxx)) textbook++;
    }
    expect(covered / runs).toBeCloseTo(0.94, 2);
    expect(textbook / runs).toBeCloseTo(0.64, 2);
  });

  it('warns on a thin sample and refuses an empty one', () => {
    const thin = calibrateImpact(executions(0.8, MIN_IMPACT_OBSERVATIONS - 1, 3));
    expect(Number.isFinite(thin.coefficient)).toBe(true);
    expect(thin.warnings.join(' ')).toMatch(/not yet worth trusting/);
    const none = calibrateImpact([]);
    expect(Number.isNaN(none.coefficient)).toBe(true);
  });

  it('drops unusable executions and says how many', () => {
    const rows = [...executions(0.8, 100, 4), { shares: 0, dailyVolume: 1e7, volatility: 0.02, impact: 0.001 }];
    const c = calibrateImpact(rows);
    expect(c.observations).toBe(100);
    expect(c.warnings[0]).toMatch(/^1 executions dropped/);
  });
});

/**
 * Why the engine does not model a missing spread from closing prices.
 *
 * Roll (1984) is the textbook estimator that needs nothing but closes:
 * bid-ask bounce makes successive price changes negatively autocorrelated, and
 * spread = 2 * sqrt(-cov(dp_t, dp_t-1)). It is undefined when the covariance
 * is positive. Computed here directly, on series with a known spread.
 */
function roll(prices: readonly number[]): number | undefined {
  const d = prices.slice(1).map((p, i) => p - prices[i]!);
  const a = d.slice(1);
  const b = d.slice(0, -1);
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let cov = 0;
  for (let i = 0; i < a.length; i++) cov += (a[i]! - ma) * (b[i]! - mb);
  cov /= a.length - 1;
  if (cov >= 0) return undefined;
  const mean = prices.reduce((s, x) => s + x, 0) / prices.length;
  return (2 * Math.sqrt(-cov)) / mean;
}

describe('the Roll estimator on daily closes', () => {
  function measure(spread: number, window: number): { defined: number; medianBp: number } {
    const r = uniform(7);
    const z = gaussian(r);
    const estimates: number[] = [];
    const trials = 2000;
    for (let k = 0; k < trials; k++) {
      let mid = 100;
      const prices: number[] = [];
      for (let i = 0; i < window; i++) {
        mid *= 1 + 0.01 * z();
        prices.push(mid * (1 + ((r() < 0.5 ? -1 : 1) * spread) / 2));
      }
      const e = roll(prices);
      if (e !== undefined) estimates.push(e);
    }
    estimates.sort((x, y) => x - y);
    return { defined: estimates.length / trials, medianBp: estimates[estimates.length >> 1]! * 1e4 };
  }

  it('reports a wide spread on a series that has none', () => {
    // 1% daily volatility, no bounce at all. Over 60 closes the estimator is
    // defined 55% of the time and, when it is, reports a median of 62bp:
    // sampling noise in the autocovariance, read as a spread.
    const none = measure(0, 60);
    expect(none.defined).toBeCloseTo(0.55, 2);
    expect(none.medianBp).toBeCloseTo(61.8, 1);
    // A real 5bp spread is indistinguishable from none.
    const five = measure(0.0005, 60);
    expect(Math.abs(five.medianBp - none.medianBp)).toBeLessThan(1);
    // A year of closes still reports 42bp on a spreadless series.
    expect(measure(0, 250).medianBp).toBeCloseTo(41.8, 1);
  });
});
