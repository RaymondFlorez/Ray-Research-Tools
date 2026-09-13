import { beforeAll, describe, expect, it } from 'vitest';
import { addNode, createDocument, deriveCacheKey, validateConnection } from '@picasso/canvas-core';
import { CurveEngine, type Instrument } from '../src/curve.js';
import { GridPricer, type Leg, type Market } from '../src/grid.js';
import {
  createCurveNode,
  createRateShockNode,
  curvePorts,
  evaluateCurve,
  rateShockPorts,
  readShock,
} from '../src/curveNode.js';
import {
  estimate,
  fitSensitivity,
  transmit,
  weakMappings,
  WEAK_FIT_R_SQUARED,
} from '../src/transmission.js';
import { loadPricing } from './load.js';

let curves: CurveEngine;
let grid: GridPricer;

beforeAll(async () => {
  const exports = await loadPricing();
  curves = new CurveEngine(exports);
  grid = new GridPricer(exports);
});

const market: Instrument[] = [
  { kind: 'deposit', maturity: 0.25, rate: 0.0528 },
  { kind: 'deposit', maturity: 0.5, rate: 0.0515 },
  { kind: 'swap', maturity: 1, rate: 0.047 },
  { kind: 'swap', maturity: 2, rate: 0.0428 },
  { kind: 'swap', maturity: 5, rate: 0.0388 },
  { kind: 'swap', maturity: 10, rate: 0.0392 },
  { kind: 'swap', maturity: 30, rate: 0.0396 },
];

/**
 * Synthetic daily history with a known beta and a known amount of noise, so a
 * test can assert what the estimator should recover rather than what it happens
 * to produce.
 */
function history(betaPer100bp: number, noise: number, days = 500) {
  const rateChangesBps: number[] = [];
  const returns: number[] = [];
  let seed = 12345;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648 - 0.5;
  };
  for (let i = 0; i < days; i += 1) {
    const move = random() * 12;
    rateChangesBps.push(move);
    returns.push((betaPer100bp / 100 / 100) * move + random() * noise);
  }
  return { rateChangesBps, returns };
}

describe('estimating a mapping rather than asserting one', () => {
  it('recovers a beta it was given', () => {
    const { rateChangesBps, returns } = history(-4, 0.0005);
    const fit = estimate(rateChangesBps, returns);
    expect(fit).toBeDefined();
    if (!fit) return;
    // -4% per 100bp, expressed per basis point.
    expect(fit.slope * 100 * 100).toBeCloseTo(-4, 0);
    expect(fit.rSquared).toBeGreaterThan(0.9);
    expect(fit.weak).toBe(false);
    expect(fit.observations).toBe(500);
  });

  it('marks a weak fit weak, at the threshold the PRD sets', () => {
    // The same beta buried in ten times the noise.
    const noisy = estimate(...Object.values(history(-4, 0.02)) as [number[], number[]]);
    expect(noisy).toBeDefined();
    if (!noisy) return;
    expect(noisy.rSquared).toBeLessThan(WEAK_FIT_R_SQUARED);
    expect(noisy.weak).toBe(true);
    // And the standard error is wide enough to contain zero, which is the point.
    expect(Math.abs(noisy.slope)).toBeLessThan(2 * noisy.standardError * 3);
  });

  it('refuses to fit what cannot be fitted', () => {
    expect(estimate([1, 2], [1, 2])).toBeUndefined();
    // A rate that never moves explains nothing, however well the line fits.
    expect(estimate([0, 0, 0, 0], [1, 2, 3, 4])).toBeUndefined();
  });

  it('does not claim to explain a constant', () => {
    const flat = estimate([1, 2, 3, 4, 5], [7, 7, 7, 7, 7]);
    expect(flat?.rSquared).toBe(0);
    expect(flat?.weak).toBe(true);
  });
});

describe('the rate shock reaches the option book', () => {
  const book: Leg[] = [
    { strike: 100, time: 1, kind: 'call', style: 'european', quantity: 50, multiplier: 100, vol: 0.28 },
    { strike: 120, time: 1, kind: 'call', style: 'european', quantity: -50, multiplier: 100, vol: 0.26 },
  ];
  const spot: Market = { spot: 100, rate: 0.047, dividend: 0.017 };

  function shocked(bps: number) {
    const base = curves.bootstrap(market);
    const baseRates = base.tenorRates();
    const after = curves.shocked(market, { shape: 'parallel', bps });
    return { baseRates, base, after };
  }

  it('moves the discount rate with no model in between', () => {
    const { base, after } = shocked(50);
    const result = transmit(spot, base, after, undefined);
    expect(result.rateMoveBps).toBeCloseTo(50, 6);
    expect(result.market.rate).toBeCloseTo(spot.rate + 0.005, 9);
    // With no beta estimated, spot is untouched — switched off, not assumed zero.
    expect(result.market.spot).toBe(spot.spot);
    expect(result.assumptions[0]).toContain('switched off');
  });

  it('moves spot through the estimated beta, and says what it believed', () => {
    const { rateChangesBps, returns } = history(-4, 0.0005);
    const sensitivity = fitSensitivity({
      underlier: 'NVDA',
      rateChangesBps,
      returns,
      window: ['2024-09-01', '2026-09-01'],
    });

    const { base, after } = shocked(50);
    const result = transmit(spot, base, after, sensitivity);
    // 50bp at -4% per 100bp is about -2%.
    expect(result.spotMovePct * 100).toBeCloseTo(-2, 0);
    expect(result.market.spot).toBeLessThan(spot.spot);
    // And it names the estimate, the window and the sample.
    const line = result.assumptions.join(' ');
    expect(line).toContain('NVDA spot-to-rates');
    expect(line).toContain('R²');
    expect(line).toContain('2024-09-01 to 2026-09-01');
    expect(line).not.toContain('treat as an assumption');
  });

  it('flags the name it cannot explain, and not the one it can', () => {
    const strong = fitSensitivity({
      underlier: 'NVDA',
      ...history(-4, 0.0005),
      window: ['2024-09-01', '2026-09-01'],
    });
    const weak = fitSensitivity({
      underlier: 'AVGO',
      ...history(-4, 0.02),
      window: ['2024-09-01', '2026-09-01'],
    });

    const { base, after } = shocked(50);
    // PRD 5.3: the node "says so plainly rather than pretending both are
    // reliable" — one name is flagged and the other is not.
    expect(transmit(spot, base, after, weak).assumptions.join(' ')).toContain(
      'treat as an assumption',
    );
    expect(transmit(spot, base, after, strong).assumptions.join(' ')).not.toContain(
      'treat as an assumption',
    );

    const audit = weakMappings([strong, weak].filter((s) => s !== undefined));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain('AVGO');
  });

  it('reprices the whole book against the shocked market', () => {
    const sensitivity = fitSensitivity({
      underlier: 'NVDA',
      ...history(-4, 0.0005),
      volChanges: history(-4, 0.0005).returns.map((r) => r * -40),
      window: ['2024-09-01', '2026-09-01'],
    });

    const spec = { spotSteps: 25, spotRange: 0.2, volSteps: 15, volRange: 0.1 } as const;
    const before = grid.reprice(book, spot, spec);

    const { base, after } = shocked(75);
    const result = transmit(spot, base, after, sensitivity);
    const shiftedBook = book.map((leg) => ({
      ...leg,
      vol: leg.vol + result.volShiftPoints,
    }));
    const afterGrid = grid.reprice(shiftedBook, result.market, spec);

    // The call spread is long the underlying, and the rate move pushed spot
    // down, so the book is worth less.
    const centre = (g: typeof before) => g.cell((g.spotCount - 1) >> 1, (g.volCount - 1) >> 1);
    expect(centre(afterGrid).value).toBeLessThan(centre(before).value);
    // Every channel did something, and the node can say which.
    expect(result.rateMoveBps).toBeCloseTo(75, 6);
    expect(result.spotMovePct).toBeLessThan(0);
    expect(result.volShiftPoints).not.toBe(0);
    expect(result.assumptions).toHaveLength(2);
  });

  it('reads what the curve did, not what the shock was called', () => {
    const base = curves.bootstrap(market);
    // A steepener pivoting at 2y barely moves the one-year point, so a one-year
    // option should barely notice it — even though the shock is "40bp".
    const steep = curves.shocked(market, { shape: 'steepener', bps: 40, pivot: 2 });
    const steepResult = transmit(spot, base, steep, undefined, { pricingTenor: 1 });
    const flatResult = transmit(
      spot,
      base,
      curves.shocked(market, { shape: 'parallel', bps: 40 }),
      undefined,
      { pricingTenor: 1 },
    );
    expect(Math.abs(steepResult.rateMoveBps)).toBeLessThan(Math.abs(flatResult.rateMoveBps) / 2);
    // And a thirty-year option would see the steepener at nearly full size.
    const long = transmit(spot, base, steep, undefined, { pricingTenor: 30 });
    expect(long.rateMoveBps).toBeCloseTo(40, 0);
  });
});

describe('the nodes on the canvas', () => {
  it('a curve wires into a rate shock', () => {
    const curve = createCurveNode({ id: 'usd', method: { kind: 'bootstrap', instruments: market } });
    const shock = createRateShockNode({
      id: 'bear-flattener',
      shock: { shape: 'flattener', bps: 25, pivot: 5 },
    });
    const result = validateConnection(curve, 'curve', shock, 'curve');
    expect(result.ok).toBe(true);
    expect(curvePorts().outputs[0]?.type).toBe('curve');
    expect(rateShockPorts().inputs[0]?.type).toBe('curve');
  });

  it('bootstraps and says it reproduced the quotes', () => {
    const node = createCurveNode({ id: 'usd', method: { kind: 'bootstrap', instruments: market } });
    const evaluation = evaluateCurve(node, curves);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    expect(evaluation.badge).toBe(`bootstrapped, reprices all ${market.length} quotes`);
    expect(node.state.status).toBe('ready');
    expect(evaluation.rates).toHaveLength(10);
  });

  it('fits, and marks the node unverified when the fit misses', () => {
    const observations = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30].map((tenor, i) => ({
      tenor,
      rate: 0.04 + 0.004 * Math.log(1 + tenor) + (i === 4 ? 0.003 : 0),
    }));
    const node = createCurveNode({ id: 'govt', method: { kind: 'nss', observations } });
    const evaluation = evaluateCurve(node, curves);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;

    expect(evaluation.badge).toContain('misses');
    expect(evaluation.fit?.warning).toBeDefined();
    // A curve that does not explain its quotes is not a verified value, and the
    // canvas has a status for exactly that.
    expect(node.state.status).toBe('unverified');
    // And the fitted shape is still a usable curve.
    expect(evaluation.curve.zero(15)).toBeGreaterThan(0);
  });

  it('leaves a sketched curve alone', () => {
    const node = createCurveNode({
      id: 'sketch',
      method: { kind: 'bootstrap', instruments: market },
      binding: 'loose',
    });
    const evaluation = evaluateCurve(node, curves);
    expect(evaluation.ok).toBe(false);
    expect(node.state.status).toBe('idle');
  });

  it('says what is wrong instead of drawing an empty curve', () => {
    const node = createCurveNode({ id: 'empty', method: { kind: 'bootstrap', instruments: [] } });
    expect(evaluateCurve(node, curves).ok).toBe(false);
    expect(node.state.error?.code).toBe('no_quotes');

    const thin = createCurveNode({
      id: 'thin',
      method: { kind: 'nss', observations: [{ tenor: 1, rate: 0.04 }] },
    });
    expect(evaluateCurve(thin, curves).ok).toBe(false);
    expect(thin.state.error?.message).toContain('six parameters');
  });

  it('puts the quotes in the cache key', () => {
    const keyFor = (instruments: Instrument[]) => {
      const doc = createDocument('rates');
      addNode(doc, createCurveNode({ id: 'usd', method: { kind: 'bootstrap', instruments } }));
      return deriveCacheKey(doc, 'usd');
    };
    const base = keyFor(market);
    expect(base).toBeDefined();
    expect(keyFor([...market])).toBe(base);

    const moved = market.map((i, idx) =>
      idx === 3 && i.kind === 'swap' ? { ...i, rate: i.rate + 0.0001 } : i,
    );
    expect(keyFor(moved)).not.toBe(base);
  });

  it('round-trips a shock through params', () => {
    const node = createRateShockNode({
      id: 'shock',
      shock: { shape: 'butterfly', bps: 30, pivot: 5 },
    });
    expect(readShock(node)).toEqual({ shape: 'butterfly', bps: 30, pivot: 5 });
  });
});
