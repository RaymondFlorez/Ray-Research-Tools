import { beforeAll, describe, expect, it } from 'vitest';
import { GridPricer, type Market } from '../src/grid.js';
import type { PricingExports } from '../src/module.js';
import {
  NoMarketFor,
  UNCLASSIFIED,
  aggregateGreeks,
  priceEach,
  type Position,
} from '../src/aggregate.js';
import { loadPricing } from './load.js';

let wasm: PricingExports;
let pricer: GridPricer;

beforeAll(async () => {
  wasm = await loadPricing();
  pricer = new GridPricer(wasm);
});

const markets: Record<string, Market> = {
  NVDA: { spot: 900, rate: 0.045, dividend: 0.0003 },
  AMD: { spot: 160, rate: 0.045, dividend: 0 },
  XLU: { spot: 9, rate: 0.045, dividend: 0.03 },
};

const book: Position[] = [
  { id: 'nvda-c', underlier: 'NVDA', sector: 'semis', leg: { strike: 950, time: 20 / 365, kind: 'call', style: 'american', quantity: 3, multiplier: 100, vol: 0.5 } },
  { id: 'nvda-p', underlier: 'NVDA', sector: 'semis', leg: { strike: 850, time: 200 / 365, kind: 'put', style: 'american', quantity: -2, multiplier: 100, vol: 0.46 } },
  { id: 'amd-c', underlier: 'AMD', sector: 'semis', leg: { strike: 170, time: 60 / 365, kind: 'call', style: 'european', quantity: 10, multiplier: 100, vol: 0.44 } },
  { id: 'xlu-c', underlier: 'XLU', sector: 'utilities', leg: { strike: 9, time: 5 / 365, kind: 'call', style: 'european', quantity: 30, multiplier: 100, vol: 0.15 } },
  { id: 'loose-p', underlier: 'AMD', leg: { strike: 150, time: 500 / 365, kind: 'put', style: 'european', quantity: 4, multiplier: 100, vol: 0.4 } },
];

describe('one position, checked against Black-Scholes', () => {
  it('matches the closed-form Greeks for a European leg, scaled to the position', () => {
    // A different path through the engine: the grid against the scalar
    // Greeks. The grid is what the aggregate uses, so it is what is checked.
    const [amd] = priceEach(pricer, [book[2]!], markets);
    const m = markets.AMD!;
    const leg = book[2]!.leg;
    const scale = leg.quantity * leg.multiplier;
    const greek = (which: number) =>
      wasm.pc_greek(m.spot, leg.strike, leg.time, m.rate, m.dividend, leg.vol, 1, which) * scale;
    expect(amd!.value).toBeCloseTo(greek(0), 8);
    expect(amd!.delta).toBeCloseTo(greek(1), 8);
    expect(amd!.gamma).toBeCloseTo(greek(2), 8);
    expect(amd!.vega).toBeCloseTo(greek(3), 6);
    expect(amd!.theta).toBeCloseTo(greek(4), 6);
  });
});

describe('grouping', () => {
  it('conserves every total across every grouping', () => {
    for (const by of ['underlier', 'sector', 'expiry'] as const) {
      const { rows, total } = aggregateGreeks(pricer, book, markets, by);
      for (const field of ['dollarDelta', 'dollarGammaPerPct', 'vegaPerVolPoint', 'thetaPerDay', 'value'] as const) {
        const sum = rows.reduce((a, r) => a + r[field], 0);
        expect(sum).toBeCloseTo(total[field], 6);
      }
      expect(rows.flatMap((r) => r.positions).sort()).toEqual(book.map((p) => p.id).sort());
    }
  });

  it('reports share delta only where it adds: inside one underlier', () => {
    const byName = aggregateGreeks(pricer, book, markets, 'underlier');
    for (const row of byName.rows) expect(row.shareDelta).toBeDefined();
    const nvda = byName.rows.find((r) => r.key === 'NVDA')!;
    expect(nvda.dollarDelta).toBeCloseTo(nvda.shareDelta! * 900, 6);

    // Three hundred shares of a $900 stock and of a $9 one are not six
    // hundred of anything.
    const bySector = aggregateGreeks(pricer, book, markets, 'sector');
    const semis = bySector.rows.find((r) => r.key === 'semis')!;
    expect(semis.underliers).toEqual(['AMD', 'NVDA']);
    expect(semis.shareDelta).toBeUndefined();
    expect('shareDelta' in semis).toBe(false);
    expect(bySector.total.shareDelta).toBeUndefined();
  });

  it('keeps a position with no sector as its own row', () => {
    const { rows } = aggregateGreeks(pricer, book, markets, 'sector');
    const unclassified = rows.find((r) => r.key === UNCLASSIFIED)!;
    expect(unclassified.positions).toEqual(['loose-p']);
  });

  it('buckets by calendar days to expiry, in bucket order', () => {
    const { rows } = aggregateGreeks(pricer, book, markets, 'expiry');
    expect(rows.map((r) => r.key)).toEqual(['0-7d', '8-30d', '31-90d', '91d-1y', '>1y']);
    expect(rows.find((r) => r.key === '0-7d')!.positions).toEqual(['xlu-c']);
    expect(rows.find((r) => r.key === '>1y')!.positions).toEqual(['loose-p']);
  });

  it('puts the name carrying the book first', () => {
    const { rows } = aggregateGreeks(pricer, book, markets, 'underlier');
    const magnitudes = rows.map((r) => Math.abs(r.dollarDelta));
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a));
  });

  it('refuses a position whose underlier has no market', () => {
    const stray: Position = { ...book[0]!, id: 'stray', underlier: 'TSM' };
    expect(() => aggregateGreeks(pricer, [stray], markets, 'underlier')).toThrow(NoMarketFor);
  });
});

describe('units', () => {
  it('reports vega per vol point and theta per calendar day', () => {
    const [amd] = priceEach(pricer, [book[2]!], markets);
    const { total } = aggregateGreeks(pricer, [book[2]!], markets, 'underlier');
    expect(total.vegaPerVolPoint).toBeCloseTo(amd!.vega / 100, 9);
    expect(total.thetaPerDay).toBeCloseTo(amd!.theta / 365, 9);
  });

  it('reports dollar gamma as the change in dollar delta for a one percent move', () => {
    // Checked by moving spot one percent through the engine, not by the formula.
    const position = book[2]!;
    const { total } = aggregateGreeks(pricer, [position], markets, 'underlier');
    const m = markets.AMD!;
    const up = priceEach(pricer, [position], { AMD: { ...m, spot: m.spot * 1.005 } })[0]!;
    const down = priceEach(pricer, [position], { AMD: { ...m, spot: m.spot * 0.995 } })[0]!;
    const moved = up.delta * up.spot - down.delta * down.spot;
    // The finite difference also carries delta times the spot move, which a
    // gamma figure deliberately excludes; take it out before comparing.
    const pure = moved - ((up.delta + down.delta) / 2) * (up.spot - down.spot);
    // 3,500.64 against 3,500.18 on this position: the residual is the
    // difference's own second-order term (speed), not a units error, which
    // would be off by a factor of a hundred or of spot.
    expect(Math.abs(total.dollarGammaPerPct - pure) / pure).toBeLessThan(5e-4);
  });
});
