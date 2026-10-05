import { beforeAll, describe, expect, it } from 'vitest';
import { CurveEngine, STANDARD_TENORS, type Instrument } from '../src/curve.js';
import { estimateShockShape, shockFromShape, ShapeNotEstimable, type CurveEvent } from '../src/shockShape.js';
import { loadPricing } from './load.js';

// The curve's true response, per bp of surprise. Hawkish surprises lift the
// front and the belly most and the long end least (a bear flattener with a
// hump at two years); dovish ones mostly move the front.
const HAWKISH = [1.0, 1.1, 1.2, 1.3, 1.2, 1.0, 0.85, 0.7, 0.5, 0.4];
const DOVISH = [1.0, 0.9, 0.7, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1, 0.1];

function events(count: number, seed: number): CurveEvent[] {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  return Array.from({ length: count }, (_, i) => {
    const surprise = 5 * normal();
    const loadings = surprise > 0 ? HAWKISH : DOVISH;
    // Day noise with a common component, so the tenors' errors correlate.
    const common = normal();
    return {
      date: `event-${i}`,
      surprise,
      changes: loadings.map((l) => l * surprise + 1.5 * common + 1.5 * normal()),
    };
  });
}

const sample = events(120, 1);

describe('estimateShockShape (PRD 5.7)', () => {
  it('recovers the hawkish shape from hawkish events', () => {
    const est = estimateShockShape(events(400, 209_458));
    const z = est.loadings.slice(1).map((l, i) => (l.shape - HAWKISH[i + 1]!) / l.shapeStandardError);
    // 206 hawkish events of 400; every tenor within 1.8 standard errors.
    expect(est.events).toBe(206);
    expect(Math.max(...z.map(Math.abs))).toBeLessThan(2);

    // Pooling hawkish and dovish days averages two shapes. Measured on the
    // same events, the pooled 3y multiple is 0.81 against a hawkish truth of
    // 1.2 — seven of the conditional estimate's standard errors away.
    const pooled = estimateShockShape(events(400, 209_458), { condition: 'pooled' });
    const threeYear = pooled.loadings.find((l) => l.tenor === 3)!;
    expect(threeYear.shape).toBeCloseTo(0.807, 3);
    expect((HAWKISH[4]! - threeYear.shape) / est.loadings[4]!.shapeStandardError).toBeGreaterThan(6);
  });

  it('has a shape error that covers the truth', () => {
    let covered = 0;
    let total = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const est = estimateShockShape(events(120, seed * 7919));
      for (const [i, l] of est.loadings.entries()) {
        if (i === 0) continue;
        total += 1;
        if (Math.abs(l.shape - HAWKISH[i]!) < 1.96 * l.shapeStandardError) covered += 1;
      }
    }
    // Measured 0.948 over 1,800 tenor-estimates: the delta method with the
    // residual covariance between equations holds.
    expect(covered / total).toBeCloseTo(0.948, 3);
  });

  it('refuses what it cannot estimate', () => {
    expect(() => estimateShockShape(sample.slice(0, 10))).toThrow(ShapeNotEstimable);
    expect(() => estimateShockShape(sample, { anchor: 4 })).toThrow(/not one of the tenors/);
    expect(() => estimateShockShape([{ date: 'x', surprise: 1, changes: [1, 2] }])).toThrow(/2 changes for 10 tenors/);
  });
});

describe('the estimated shape through the engine', () => {
  let curves: CurveEngine;
  beforeAll(async () => {
    curves = new CurveEngine(await loadPricing());
  });
  const market: Instrument[] = [
    { kind: 'deposit', maturity: 0.25, rate: 0.0528 },
    { kind: 'deposit', maturity: 0.5, rate: 0.0515 },
    { kind: 'swap', maturity: 1, rate: 0.0471 },
    { kind: 'swap', maturity: 2, rate: 0.0428 },
    { kind: 'swap', maturity: 3, rate: 0.0401 },
    { kind: 'swap', maturity: 5, rate: 0.0388 },
    { kind: 'swap', maturity: 7, rate: 0.0387 },
    { kind: 'swap', maturity: 10, rate: 0.0392 },
    { kind: 'swap', maturity: 20, rate: 0.0407 },
    { kind: 'swap', maturity: 30, rate: 0.0396 },
  ];

  it('moves the anchor by the stated size and every other tenor by its multiple', () => {
    const est = estimateShockShape(sample);
    const shock = shockFromShape(est, 50);
    expect(shock.points.map((p) => p.tenor)).toEqual([...STANDARD_TENORS]);
    const base = curves.bootstrap(market);
    const shocked = curves.shocked(market, shock);
    for (const l of est.loadings) {
      const moved = (shocked.zero(l.tenor) - base.zero(l.tenor)) * 10_000;
      expect(moved).toBeCloseTo(50 * l.shape, 6);
    }
  });
});
