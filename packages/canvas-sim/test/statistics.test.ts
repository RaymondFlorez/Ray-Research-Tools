import { describe, expect, it } from 'vitest';
import { carryCost, fillCost, DEFAULT_COSTS } from '../src/costs.js';
import { cvar, deflatedSharpe, maxDrawdown, moments, percentile, sharpe } from '../src/statistics.js';

describe('moments', () => {
  it('measures a normal-ish sample', () => {
    const m = moments([1, 2, 3, 4, 5]);
    expect(m.mean).toBe(3);
    expect(m.stdev).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(m.skew).toBeCloseTo(0, 12);
    expect(m.count).toBe(5);
  });

  it('sees a left tail', () => {
    // Small gains most days, one large loss — the shape that flatters a Sharpe
    // ratio and then ruins the fund.
    const returns = [...Array.from({ length: 50 }, () => 0.002), -0.15];
    expect(moments(returns).skew).toBeLessThan(-3);
    expect(moments(returns).kurtosis).toBeGreaterThan(10);
  });
});

describe('the deflated Sharpe ratio', () => {
  const good = Array.from({ length: 500 }, (_, i) => 0.0009 + Math.sin(i * 2.4) * 0.008);

  it('barely deflates a single trial', () => {
    const one = deflatedSharpe(good, 1);
    expect(one.expectedMaximum).toBe(0);
    expect(one.observed).toBeGreaterThan(1);
  });

  /**
   * "A deflated Sharpe ratio adjusted for the number of trials the analyst has
   * run on this canvas. The trial counter is tracked automatically, which is
   * uncomfortable and correct."
   *
   * The same returns, found after one attempt or after a thousand, are not the
   * same evidence. This is that sentence as arithmetic.
   */
  it('raises the bar with every strategy the analyst tried', () => {
    const bars = [1, 10, 100, 1000].map((trials) => deflatedSharpe(good, trials));
    for (let i = 1; i < bars.length; i += 1) {
      expect((bars[i] as (typeof bars)[0]).expectedMaximum).toBeGreaterThan(
        (bars[i - 1] as (typeof bars)[0]).expectedMaximum,
      );
      // Same returns, less belief.
      expect((bars[i] as (typeof bars)[0]).probability).toBeLessThan(
        (bars[i - 1] as (typeof bars)[0]).probability,
      );
    }
    // The observed Sharpe never moves; only what it is worth does.
    expect(bars.every((b) => b.observed === (bars[0] as (typeof bars)[0]).observed)).toBe(true);
  });

  it('penalises a strategy whose returns are skewed against it', () => {
    const n = 400;
    const symmetric = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.006 : -0.004));
    const crashy = [...Array.from({ length: n - 4 }, () => 0.0016), -0.06, -0.05, -0.04, -0.03];

    const a = deflatedSharpe(symmetric, 50);
    const b = deflatedSharpe(crashy, 50);
    // Comparable headline Sharpes, and the skewed one is believed less.
    expect(Math.abs(a.observed - b.observed)).toBeLessThan(Math.max(a.observed, b.observed));
    expect(moments(crashy).skew).toBeLessThan(-2);
    expect(b.probability).toBeLessThan(a.probability);
  });

  it('flags a strategy that has not cleared its own search', () => {
    const mediocre = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? 0.004 : -0.0018));
    expect(deflatedSharpe(mediocre, 500).notSignificant).toBe(true);
  });
});

describe('drawdown and tails', () => {
  it('finds the deepest peak-to-trough fall and how long it took', () => {
    const d = maxDrawdown([100, 120, 90, 60, 80, 130]);
    expect(d.maximum).toBeCloseTo(0.5, 12);
    expect(d.troughAt).toBe(3);
    expect(d.length).toBe(2);
  });

  it('reports no drawdown on a line that only rises', () => {
    expect(maxDrawdown([1, 2, 3, 4]).maximum).toBe(0);
  });

  it('averages the tail rather than picking a point on it', () => {
    const values = [-0.10, -0.08, -0.05, -0.01, 0, 0.01, 0.02, 0.03, 0.04, 0.05];
    // The worst 20% is two observations, and CVaR is their mean.
    expect(cvar(values, 0.2)).toBeCloseTo(-0.09, 12);
    // Which is worse than the percentile at the same alpha, always.
    expect(cvar(values, 0.2)).toBeLessThan(percentile(values, 0.2));
  });
});

describe('the cost model', () => {
  it('charges commission, spread and impact', () => {
    const cost = fillCost({ shares: 10_000, price: 100, spread: 0.0004, dailyVolume: 5e6, volatility: 0.02 });
    expect(cost.commission).toBe(50);
    expect(cost.spread).toBeCloseTo(10_000 * 100 * 0.0004 * 0.5, 9);
    expect(cost.impact).toBeGreaterThan(0);
    expect(cost.total).toBeCloseTo(cost.commission + cost.spread + cost.impact, 9);
  });

  /**
   * The square-root law is the term that decides whether a strategy scales.
   * Ten times the size costs about three times as much per share, so thirty
   * times in total — which is why a backtest run at $1m and traded at $100m is
   * a different strategy.
   */
  it('makes size cost more than proportionally', () => {
    const small = fillCost({ shares: 10_000, price: 100, spread: 0, dailyVolume: 1e6, volatility: 0.02 });
    const large = fillCost({ shares: 100_000, price: 100, spread: 0, dailyVolume: 1e6, volatility: 0.02 });
    expect(large.impact / small.impact).toBeCloseTo(Math.sqrt(10) * 10, 6);
    // Per share, the cost has risen too.
    expect(large.impact / 100_000).toBeCloseTo((small.impact / 10_000) * Math.sqrt(10), 9);
  });

  it('a buy pays up and a sell receives less', () => {
    const context = { price: 100, spread: 0.001, dailyVolume: 1e7, volatility: 0.02 };
    expect(fillCost({ ...context, shares: 1000 }).effectivePrice).toBeGreaterThan(100);
    expect(fillCost({ ...context, shares: -1000 }).effectivePrice).toBeLessThan(100);
  });

  it('charges borrow on shorts and financing on leverage', () => {
    const flat = new Map([['A', { shares: 1000, price: 100 }]]);
    expect(carryCost(flat, 100_000, DEFAULT_COSTS, 1)).toBeCloseTo(0, 9);

    const short = new Map([['A', { shares: -1000, price: 100 }]]);
    expect(carryCost(short, 100_000, DEFAULT_COSTS, 1)).toBeCloseTo(
      (100_000 * DEFAULT_COSTS.borrowRate) / 365,
      9,
    );

    // Gross of 300k on 100k of equity is 200k financed.
    const levered = new Map([['A', { shares: 3000, price: 100 }]]);
    expect(carryCost(levered, 100_000, DEFAULT_COSTS, 1)).toBeCloseTo(
      (200_000 * DEFAULT_COSTS.financingRate) / 365,
      9,
    );
  });

  it('costs nothing to trade nothing', () => {
    expect(fillCost({ shares: 0, price: 100, spread: 0.001, dailyVolume: 1e6, volatility: 0.02 }).total).toBe(0);
  });
});

describe('sharpe', () => {
  it('annualizes', () => {
    const daily = Array.from({ length: 252 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.006));
    expect(sharpe(daily, 252)).toBeCloseTo(sharpe(daily, 1) * Math.sqrt(252), 9);
  });

  it('is zero for a flat line rather than infinite', () => {
    expect(sharpe([0, 0, 0, 0])).toBe(0);
  });
});
