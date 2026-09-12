import { beforeAll, describe, expect, it } from 'vitest';
import { CurveEngine, STANDARD_TENORS, type Instrument } from '../src/curve.js';
import { loadPricing } from './load.js';

let curves: CurveEngine;

beforeAll(async () => {
  curves = new CurveEngine(await loadPricing());
});

/** Cash out to six months, futures through the first year, swaps beyond. */
const market: Instrument[] = [
  { kind: 'deposit', maturity: 0.0833, rate: 0.0533 },
  { kind: 'deposit', maturity: 0.25, rate: 0.0528 },
  { kind: 'deposit', maturity: 0.5, rate: 0.0515 },
  { kind: 'future', start: 0.5, end: 0.75, rate: 0.0496, convexityBps: 0.4 },
  { kind: 'future', start: 0.75, end: 1.0, rate: 0.0471, convexityBps: 0.7 },
  { kind: 'swap', maturity: 2, rate: 0.0428 },
  { kind: 'swap', maturity: 3, rate: 0.0401 },
  { kind: 'swap', maturity: 5, rate: 0.0388 },
  { kind: 'swap', maturity: 7, rate: 0.0387 },
  { kind: 'swap', maturity: 10, rate: 0.0392 },
  { kind: 'swap', maturity: 20, rate: 0.0407 },
  { kind: 'swap', maturity: 30, rate: 0.0396 },
];

describe('bootstrapping in the browser', () => {
  it('reprices every instrument it was built from', () => {
    const curve = curves.bootstrap(market);
    expect(curve.pins).toBe(market.length);
    // The claim a CurveNode makes when it says it reproduces the market.
    expect(curve.worstResidualBps()).toBeLessThan(1e-8);
  });

  it('gives back the rates that were quoted', () => {
    const curve = curves.bootstrap(market);
    // A 10-year par swap at 3.92% has a 10-year zero near it, a little above
    // because the curve is inverted at the front and the coupons discount there.
    expect(curve.zero(10)).toBeGreaterThan(0.035);
    expect(curve.zero(10)).toBeLessThan(0.045);
    // The front is inverted, which is what this market was.
    expect(curve.zero(0.25)).toBeGreaterThan(curve.zero(5));
  });

  it('discounts fall away monotonically', () => {
    const curve = curves.bootstrap(market);
    let previous = 1;
    for (let t = 0.25; t <= 30; t += 0.25) {
      const df = curve.discount(t);
      expect(df).toBeGreaterThan(0);
      expect(df).toBeLessThan(previous);
      previous = df;
    }
  });

  it('refuses to build from nothing rather than returning a flat curve', () => {
    expect(() => curves.bootstrap([])).toThrow(/at least one quote/);
  });

  it('says so when the instruments do not build', () => {
    expect(() =>
      curves.bootstrap([
        { kind: 'swap', maturity: 5, rate: 0.04 },
        { kind: 'deposit', maturity: 5, rate: 0.05 },
      ]),
    ).toThrow(/do not build a curve/);
  });
});

describe('shocks', () => {
  it('moves every tenor alike under a parallel shift', () => {
    const base = curves.bootstrap(market).tenorRates();
    const shocked = curves.shocked(market, { shape: 'parallel', bps: 50 }).tenorRates();
    for (let i = 0; i < base.length; i += 1) {
      const moved = ((shocked[i]?.rate ?? 0) - (base[i]?.rate ?? 0)) * 10_000;
      expect(moved).toBeCloseTo(50, 6);
    }
  });

  it('pivots a steepener where it says it does', () => {
    const base = curves.bootstrap(market);
    const rates = base.tenorRates();
    const shocked = curves.shocked(market, { shape: 'steepener', bps: 40, pivot: 2 });

    const at = (tenor: number) => rates.find((r) => r.tenor === tenor)?.rate ?? 0;
    expect((shocked.zero(2) - at(2)) * 10_000).toBeCloseTo(0, 6);
    expect((shocked.zero(30) - at(30)) * 10_000).toBeCloseTo(40, 6);
    // The short end goes the other way, which is what makes it a rotation.
    expect(shocked.zero(0.25)).toBeLessThan(at(0.25));
  });

  it('does not compound when the same shock is asked for twice', () => {
    const once = curves.shocked(market, { shape: 'parallel', bps: 50 }).zero(10);
    const again = curves.shocked(market, { shape: 'parallel', bps: 50 }).zero(10);
    expect(again).toBe(once);
  });

  it('records which shock produced it', () => {
    const shocked = curves.shocked(market, { shape: 'butterfly', bps: 30, pivot: 5 });
    expect(shocked.shock).toEqual({ shape: 'butterfly', bps: 30, pivot: 5 });
  });
});

describe('Nelson-Siegel-Svensson', () => {
  it('fits a curve and reports how well', () => {
    const curve = curves.bootstrap(market);
    const fit = curves.fitNss(curve.tenorRates());
    expect(fit).toBeDefined();
    if (!fit) return;

    expect(fit.residuals).toHaveLength(STANDARD_TENORS.length);
    expect(fit.tau2).toBeGreaterThan(fit.tau1);
    // It fits somewhere near the observations it was given.
    for (const { tenor, rate } of curve.tenorRates()) {
      expect(Math.abs(fit.zero(tenor) - rate) * 10_000).toBeLessThan(fit.maxAbsBps + 1e-6);
    }
    // And extrapolates to a tenor nobody quoted, which is the point of fitting
    // a shape rather than interpolating points.
    expect(Number.isFinite(fit.zero(40))).toBe(true);
  });

  it('warns rather than drawing a smooth lie', () => {
    const observations = STANDARD_TENORS.map((tenor) => ({
      tenor,
      rate: 0.04 + 0.004 * Math.log(1 + tenor),
    }));
    // One bond marked 30bp away from its neighbours, as a squeeze looks.
    const dislocated = observations.map((o, i) =>
      i === 4 ? { ...o, rate: o.rate + 0.003 } : o,
    );

    const clean = curves.fitNss(observations);
    const messy = curves.fitNss(dislocated);
    expect(clean?.warning).toBeUndefined();
    expect(messy?.warning).toContain('does not explain');
    // And names the tenor, so the analyst can go and look at that bond.
    expect(messy?.worstTenor).toBe(STANDARD_TENORS[4]);
    expect(messy?.maxAbsBps).toBeGreaterThan(clean?.maxAbsBps ?? 0);
  });

  it('refuses fewer observations than it has parameters', () => {
    expect(curves.fitNss([{ tenor: 1, rate: 0.04 }, { tenor: 5, rate: 0.042 }])).toBeUndefined();
  });

  it('the residual is observed minus fitted, in that order', () => {
    const observations = STANDARD_TENORS.map((tenor) => ({
      tenor,
      rate: 0.04 + 0.003 * Math.log(1 + tenor),
    }));
    const marked = observations.map((o, i) => (i === 7 ? { ...o, rate: o.rate + 0.005 } : o));
    const fit = curves.fitNss(marked);
    expect(fit?.residuals[7]).toBeGreaterThan(0);
  });
});

describe('the budget', () => {
  it('bootstraps inside the sub-millisecond claim, in the browser', () => {
    curves.bootstrap(market);
    const runs = Array.from({ length: 40 }, () => {
      const t0 = performance.now();
      curves.bootstrap(market);
      return performance.now() - t0;
    });
    runs.sort((a, b) => a - b);
    const p95 = runs[38] as number;
    console.log(`  bootstrap, 12 instruments: p95 ${p95.toFixed(3)}ms`);
    expect(p95).toBeLessThan(1);
  });
});
