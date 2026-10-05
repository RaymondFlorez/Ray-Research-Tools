import { describe, expect, it } from 'vitest';
import { backtest, History, type Strategy } from '../src/index.js';

const dates = Array.from({ length: 10 }, (_, d) => new Date(Date.UTC(2024, 0, 1 + d)).toISOString().slice(0, 10));
const OPTIONS = { symbols: ['GONE'], trials: 1 };
const holdGone: Strategy = () => [{ symbol: 'GONE', targetShares: 10_000 }];

/** 10,000 shares of GONE at 50, bought on the second bar; prints stop after the fifth. */
function delisting(delistingReturn?: number): History {
  const h = new History();
  h.addSeries('price:ALIVE', dates.map((date) => ({ date, value: 100 })));
  h.addSeries('price:GONE', dates.slice(0, 5).map((date) => ({ date, value: 50 })));
  if (delistingReturn !== undefined) h.delist('GONE', dates[5]!, delistingReturn);
  return h;
}

describe('delisting returns (PRD 5.8 survivorship)', () => {
  // Before this, a held name whose prices stopped was dropped from the mark:
  // equity went from 999,509 to 499,509 on the first bar without a print —
  // a 100% loss on the 500,000 position whatever the holders received.

  it('settles a merger cash-out at the last price compounded by the delisting return', () => {
    const r = backtest(delisting(0.2), holdGone, OPTIONS);
    const before = r.equity[4]!;
    expect(r.equity[5]! - before).toBeCloseTo(10_000 * 50 * 0.2, 6);
    const settlement = r.trades.find((t) => t.delisting !== undefined)!;
    expect(settlement).toMatchObject({ date: dates[5], symbol: 'GONE', shares: -10_000, price: 60, cost: 0 });
    expect(settlement.delisting).toEqual({ lastPrice: 50, delistingReturn: 0.2 });
    // Flat in cash afterwards, and nothing stale.
    expect(r.equity.slice(5).every((e) => e === r.equity[5])).toBe(true);
    expect(r.staleMarks).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('settles a bankruptcy at most of nothing, not at nothing', () => {
    const r = backtest(delisting(-0.3), holdGone, OPTIONS);
    expect(r.equity[5]! - r.equity[4]!).toBeCloseTo(-10_000 * 50 * 0.3, 6);
  });

  it('covers a short at the delisting value', () => {
    const r = backtest(delisting(0.2), () => [{ symbol: 'GONE', targetShares: -10_000 }], OPTIONS);
    // Short 10,000 into a 20% cash-out: the cover costs 100,000 more than the last mark.
    expect(r.equity[5]! - r.equity[4]!).toBeCloseTo(-100_000, 6);
  });

  it('does not trade back into a delisted name', () => {
    const r = backtest(delisting(0.2), holdGone, OPTIONS);
    // One buy, one settlement; the strategy keeps asking for 10,000 shares.
    expect(r.trades.map((t) => t.shares)).toEqual([10_000, -10_000]);
  });

  it('marks a name whose prints stop with no delisting at its last price, and says so', () => {
    const r = backtest(delisting(), holdGone, OPTIONS);
    expect(r.equity[9]).toBeCloseTo(r.equity[4]!, 6);
    expect(r.staleMarks).toHaveLength(5);
    expect(r.staleMarks[0]).toEqual({ date: dates[5], symbol: 'GONE', pricedOn: dates[4] });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/GONE: marked at a carried-forward price on 5 bars and still held at the end/);
    expect(r.warnings[0]).toMatch(/delisting return is missing/);
  });

  it('refuses a delisting return below -100%', () => {
    expect(() => new History().delist('X', '2024-01-01', -1.5)).toThrow(RangeError);
    expect(() => new History().delist('X', '2024-01-01', Number.NaN)).toThrow(RangeError);
  });
});

describe('a missing print', () => {
  it('carries the last price for one bar rather than halving equity', () => {
    const h = new History();
    h.addSeries('price:A', dates.filter((_, i) => i !== 4).map((date) => ({ date, value: 100 })));
    h.addSeries('price:B', dates.map((date) => ({ date, value: 100 })));
    const r = backtest(h, () => [{ symbol: 'A', targetShares: 5_000 }], { symbols: ['A'], trials: 1 });
    // Measured before the fix: 999,626 → 499,626 → 999,626, a 50% drawdown
    // that never happened.
    expect(r.equity[4]).toBeCloseTo(r.equity[3]!, 6);
    expect(r.drawdown.maximum).toBeLessThan(0.001);
    expect(r.staleMarks).toEqual([{ date: dates[4], symbol: 'A', pricedOn: dates[3] }]);
    expect(r.warnings).toEqual(['A: marked at a carried-forward price on 1 bar.']);
  });
});
