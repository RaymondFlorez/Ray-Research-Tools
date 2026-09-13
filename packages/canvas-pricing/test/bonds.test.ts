import { beforeAll, describe, expect, it } from 'vitest';
import { BondAnalytics, type CashFlow } from '../src/bonds.js';
import { CurveEngine, type Curve, type Instrument } from '../src/curve.js';
import { loadPricing } from './load.js';

let bonds: BondAnalytics;
let curves: CurveEngine;
let curve: Curve;

const market: Instrument[] = [
  { kind: 'deposit', maturity: 0.5, rate: 0.0515 },
  { kind: 'swap', maturity: 2, rate: 0.0428 },
  { kind: 'swap', maturity: 5, rate: 0.0388 },
  { kind: 'swap', maturity: 10, rate: 0.0392 },
];

/** A 4% semiannual ten-year bond, per 100 of notional. */
const bond: CashFlow[] = Array.from({ length: 20 }, (_, i) => {
  const t = 0.5 * (i + 1);
  return [t, i === 19 ? 102 : 2] as CashFlow;
});

beforeAll(async () => {
  const exports = await loadPricing();
  curves = new CurveEngine(exports);
  bonds = new BondAnalytics(exports, curves);
  curve = curves.bootstrap(market);
});

describe('yield metrics', () => {
  it('a bond at par yields its coupon', () => {
    const m = bonds.yieldMetrics(bond, 100, 2);
    expect(m?.yieldToMaturity).toBeCloseTo(0.04, 12);
  });

  it('duration is shorter than maturity and modified is shorter still', () => {
    const m = bonds.yieldMetrics(bond, 100, 2);
    expect(m).toBeDefined();
    if (!m) return;
    expect(m.macaulayDuration).toBeLessThan(10);
    expect(m.macaulayDuration).toBeGreaterThan(8);
    expect(m.modifiedDuration).toBeLessThan(m.macaulayDuration);
    expect(m.convexity).toBeGreaterThan(0);
    // DV01 per 100 of notional on a ten-year par bond is about eight cents.
    expect(m.dv01).toBeGreaterThan(0.05);
    expect(m.dv01).toBeLessThan(0.12);
  });

  it('price and yield are inverses', () => {
    for (const y of [0.01, 0.04, 0.09]) {
      const price = bonds.priceAtYield(bond, y, 2);
      expect(bonds.yieldMetrics(bond, price, 2)?.yieldToMaturity).toBeCloseTo(y, 12);
    }
  });

  it('says so when no yield reproduces a price', () => {
    expect(bonds.yieldMetrics(bond, 1e9, 2)).toBeUndefined();
  });
});

describe('spreads', () => {
  it('a bond at its curve value has no spread', () => {
    const fair = bond.reduce((sum, [t, amount]) => sum + amount * curve.discount(t), 0);
    expect(bonds.zSpread(bond, curve, fair)).toBeCloseTo(0, 10);
    expect(bonds.assetSwapSpread(bond, curve, fair)).toBeCloseTo(0, 12);
  });

  it('a cheaper bond has a wider spread on both measures', () => {
    const fair = bond.reduce((sum, [t, amount]) => sum + amount * curve.discount(t), 0);
    const z = bonds.zSpread(bond, curve, fair - 3) ?? 0;
    const asw = bonds.assetSwapSpread(bond, curve, fair - 3) ?? 0;
    expect(z).toBeGreaterThan(0);
    expect(asw).toBeGreaterThan(0);
    // Near each other for a bond near par, and not identical: the par-par
    // package carries the price difference as an upfront.
    expect(Math.abs(z - asw)).toBeLessThan(0.001);
  });

  it('reads the curve it was handed, not whichever one is live', () => {
    const shocked = curves.shocked(market, { shape: 'parallel', bps: 100 });
    const fair = bond.reduce((sum, [t, amount]) => sum + amount * curve.discount(t), 0);
    // `shocked` is the live curve now. Asking for a spread against `curve` has
    // to put `curve` back, or the answer is 100bp out.
    expect(bonds.zSpread(bond, curve, fair)).toBeCloseTo(0, 10);
    expect(bonds.zSpread(bond, shocked, fair)).toBeCloseTo(-0.01, 3);
  });
});

describe('the Hull-White lattice', () => {
  const straight = { coupon: 2, redemption: 100, slices: 20 };
  const callable = { ...straight, callFrom: 6, callPrice: 100 };
  const model = { meanReversion: 0.05, vol: 0.011 };

  it('reprices the curve it was calibrated to', () => {
    const lattice = bonds.lattice(curve, model, 0.5, 20);
    for (let step = 1; step <= 20; step += 1) {
      expect(lattice.zeroCoupon(step)).toBeCloseTo(curve.discount(0.5 * step), 12);
    }
  });

  /**
   * The check that matters. A bond with no call schedule has no option to
   * adjust for, so its OAS must be its z-spread — and the two come from
   * entirely separate code: a discounted sum, and a backward induction on a
   * fitted tree.
   */
  it('the OAS of a straight bond is its z-spread', () => {
    const lattice = bonds.lattice(curve, model, 0.5, 20);
    for (const offset of [-4, 0, 5]) {
      const fair = bond.reduce((sum, [t, amount]) => sum + amount * curve.discount(t), 0);
      const price = fair + offset;
      const oas = lattice.optionAdjustedSpread(straight, price);
      const z = bonds.zSpread(bond, curve, price);
      expect(oas).toBeCloseTo(z ?? NaN, 9);
    }
  });

  it('the call makes the bond worth less, and the option is the gap', () => {
    const lattice = bonds.lattice(curve, model, 0.5, 20);
    const withCall = lattice.price(callable, 0);
    const without = lattice.price(straight, 0);
    expect(withCall).toBeLessThan(without);
    expect(lattice.optionValue(callable, 0)).toBeCloseTo(without - withCall, 12);
  });

  it('the OAS is tighter than the z-spread on a callable', () => {
    const lattice = bonds.lattice(curve, model, 0.5, 20);
    const priced = lattice.price(callable, 0.008);
    const oas = lattice.optionAdjustedSpread(callable, priced) ?? 0;
    const z = bonds.zSpread(bond, curve, priced) ?? 0;

    expect(oas).toBeCloseTo(0.008, 9);
    // The z-spread charges the option to credit; the OAS does not.
    expect(z).toBeGreaterThan(oas);
  });
});
