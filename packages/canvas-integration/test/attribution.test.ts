/**
 * The attribution seam: a backtest's returns explained by factors.
 *
 * PRD 5.8 lists factor attribution among the BacktestNode's outputs. The
 * backtest lives in `canvas-sim` and the regression in `canvas-equity`, and
 * neither package can see the one thing that has to be right between them:
 * which bar each return belongs to. `backtest()` returns one fewer return than
 * it has dates, and a factor series joined on the wrong end still has the right
 * length, still fits, and still produces a tidy table. Both unit suites pass
 * with the join off by one bar. This file measures what that costs and holds
 * the join to `returnDates`.
 */

import { describe, expect, it } from 'vitest';
import { factorAttribution, rollingAttribution } from '@picasso/canvas-equity';
import { backtest, History, type Strategy } from '@picasso/canvas-sim';

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
const BARS = 400;
const mRet = normals(BARS, 11).map((x) => 0.0004 + 0.01 * x);
const iRet = normals(BARS, 12).map((x) => 0.003 * x);
const BETA = 1.3;
const dates: string[] = [];
const mkt: number[] = [];
const stk: number[] = [];
let pm = 100, ps = 50;
for (let d = 0; d < BARS; d++) {
  if (d > 0) { pm *= 1 + mRet[d]!; ps *= 1 + BETA * mRet[d]! + iRet[d]!; }
  dates.push(new Date(Date.UTC(2023, 0, 1 + d)).toISOString().slice(0, 10));
  mkt.push(pm); stk.push(ps);
}
const history = new History();
history.addSeries('price:MKT', dates.map((date, i) => ({ date, value: mkt[i]! })));
history.addSeries('price:STK', dates.map((date, i) => ({ date, value: stk[i]! })));
const factor = mkt.slice(1).map((p, i) => p / mkt[i]! - 1);

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const byEndDate = new Map(dates.slice(1).map((d, i) => [d, factor[i]!]));

/** Holds 900k of the stock, rebalanced daily. Exposure drifts down as equity grows. */
const hold: Strategy = (view) => [{ symbol: 'STK', targetShares: Math.floor(900_000 / view.latest('price:STK')!) }];

/** Long the market for the first half, short it for the second. */
const flip: Strategy = (view, state) => {
  const sign = dates.indexOf(state.date) < BARS / 2 ? 1 : -1;
  return [{ symbol: 'MKT', targetShares: sign * Math.floor(900_000 / view.latest('price:MKT')!) }];
};

describe('backtest -> attribution', () => {
  const run = backtest(history, hold, { symbols: ['STK'], trials: 1 });
  const aligned = run.returnDates.map((d) => byEndDate.get(d)!);

  it('joins factor returns on the date each backtest return ends', () => {
    expect(run.returnDates).toEqual(run.dates.slice(1));
    expect(aligned.every((f) => Number.isFinite(f))).toBe(true);

    const a = factorAttribution(run.returns, [{ name: 'mkt', values: aligned }]);
    const mkt = a.lines.find((l) => l.source === 'mkt')!.contribution;
    // Truth: the stock's beta times the book's exposure at the start of each bar.
    const truth = sum(run.returns.map((_, i) => run.exposure[i]! * BETA * factor[i]!));
    expect(truth).toBeCloseTo(0.4205, 4);
    expect(mkt).toBeCloseTo(0.4065, 4);
    expect(mkt / sum(aligned)).toBeCloseTo(0.998, 3);
    expect(Math.abs(a.residual)).toBeLessThan(1e-12);
  });

  it('attributes everything to alpha when the join is off by one bar', () => {
    // The same arrays, joined on the start date instead of the end: equal
    // lengths, a clean fit, no warning about alignment — and no market.
    const a = factorAttribution(run.returns.slice(1), [{ name: 'mkt', values: aligned.slice(0, -1) }]);
    const alpha = a.lines.find((l) => l.source === 'alpha')!.contribution;
    const mkt = a.lines.find((l) => l.source === 'mkt')!.contribution;
    expect(alpha).toBeCloseTo(0.4256, 4);
    expect(Math.abs(mkt)).toBeLessThan(0.005);
  });

  it("compounds to the engine's own equity curve", () => {
    const a = factorAttribution(run.returns, [{ name: 'mkt', values: aligned }]);
    const curve = run.equity[run.equity.length - 1]! / run.equity[0]! - 1;
    expect(a.compoundedTotal).toBeCloseTo(curve, 12);
    expect(a.compounding).toBeCloseTo(0.0655, 4);
  });

  it('refuses a factor series that cannot be aligned bar for bar', () => {
    const a = rollingAttribution(run.returns, [{ name: 'mkt', values: factor.slice(1) }], 60);
    expect(a.lines.every((l) => Number.isNaN(l.contribution))).toBe(true);
    expect(a.warnings.join(' ')).toMatch(/length does not match/);
  });
});

describe('a strategy that changes its exposure', () => {
  const run = backtest(history, flip, { symbols: ['MKT'], trials: 1 });
  const aligned = run.returnDates.map((d) => byEndDate.get(d)!);
  const factors = [{ name: 'mkt', values: aligned }];
  // The flip is decided on bar 200 and fills on bar 201, so bars 0..200 earn long.
  const signed = run.returns.map((_, i) => (i <= BARS / 2 ? 1 : -1) * run.exposure[i]! * factor[i]!);

  it('static attribution hides market P&L in alpha, and its R-squared warning is the only tell', () => {
    const a = factorAttribution(run.returns, factors);
    const alpha = a.lines.find((l) => l.source === 'alpha')!.contribution;
    const mkt = a.lines.find((l) => l.source === 'mkt')!.contribution;
    expect(sum(signed)).toBeCloseTo(0.0559, 4);
    // What is not market is costs: the engine charged 1.82% of starting equity.
    expect(sum(run.returns) - sum(signed)).toBeCloseTo(-0.0163, 4);
    expect(run.totalCosts / 1_000_000).toBeCloseTo(0.0182, 4);
    // The static fit reports positive alpha on a book whose only non-market
    // P&L was a cost, and almost no market.
    expect(alpha).toBeCloseTo(0.0319, 4);
    expect(mkt).toBeCloseTo(0.0077, 4);
    expect(a.warnings.join(' ')).toMatch(/R-squared is 0\.00/);
  });

  it('rolling attribution lags the flip by up to a window, and reports the miss as residual', () => {
    const a = rollingAttribution(run.returns, factors, 60);
    const mkt = a.lines.find((l) => l.source === 'mkt')!.contribution;
    // Truth over the bars rolling can attribute (t >= 60) is 0.0992. For up to
    // 60 bars after the flip the betas are still long, so the market line
    // overstates — and the gap lands in a residual that is reported, not
    // folded into alpha.
    expect(sum(signed.slice(60))).toBeCloseTo(0.0992, 4);
    expect(mkt).toBeCloseTo(0.1974, 4);
    expect(a.residual).toBeCloseTo(-0.1494, 4);
  });
});
