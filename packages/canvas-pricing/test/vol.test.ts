import { beforeAll, describe, expect, it } from 'vitest';
import type { PricingExports } from '../src/module.js';
import {
  NoEventPremium,
  SmileTooNarrow,
  TRADING_DAYS,
  WindowNotClosed,
  eventImpliedMove,
  realizedVariance,
  realizedVol,
  skew,
  termStructure,
  variancePremium,
  type SmileQuote,
} from '../src/vol.js';
import { loadPricing } from './load.js';

let wasm: PricingExports;

beforeAll(async () => {
  wasm = await loadPricing();
});

/** A series whose every log return is the same size: the vol is known exactly. */
function alternating(n: number, step: number): number[] {
  const closes = [100];
  for (let i = 0; i < n; i++) {
    const previous = closes[i]!;
    closes.push(i % 2 === 0 ? previous * (1 + step) : previous / (1 + step));
  }
  return closes;
}

describe('realized volatility', () => {
  it('recovers a known step exactly', () => {
    const step = 0.01;
    const expected = Math.log(1 + step) * Math.sqrt(TRADING_DAYS);
    expect(realizedVol(wasm, alternating(40, step))).toBeCloseTo(expected, 12);
  });

  it('does not centre its returns', () => {
    // A pure trend has zero volatility if you subtract the mean. An implied
    // vol is a zero-drift parameter, so the uncentred number is the one it is
    // comparable with.
    const closes = Array.from({ length: 40 }, (_, i) => 100 * 1.001 ** i);
    expect(realizedVol(wasm, closes)).toBeCloseTo(Math.log(1.001) * Math.sqrt(TRADING_DAYS), 12);
  });

  it('reports a broken series as missing rather than as calm', () => {
    expect(realizedVol(wasm, [100])).toBeNaN();
    expect(realizedVol(wasm, [100, 0, 100])).toBeNaN();
  });

  it('gives a variance that is the square, not the square of a rounded vol', () => {
    const closes = alternating(30, 0.008);
    const vol = realizedVol(wasm, closes);
    expect(realizedVariance(wasm, closes)).toBe(vol * vol);
  });

  it('starts from a clean series on every call', () => {
    const first = realizedVol(wasm, alternating(40, 0.01));
    realizedVol(wasm, alternating(10, 0.05));
    expect(realizedVol(wasm, alternating(40, 0.01))).toBe(first);
  });
});

describe('the term structure', () => {
  it('sorts by expiry and carries the forward volatility between each pair', () => {
    const points = termStructure(wasm, [
      { time: 0.5, vol: 0.3, expiry: '2026-09-18' },
      { time: 0.25, vol: 0.2, expiry: '2026-06-19' },
    ]);
    expect(points.map((p) => p.expiry)).toEqual(['2026-06-19', '2026-09-18']);
    expect(points[0]!.forwardVol).toBeUndefined();
    // Total variance 0.045 against 0.0025: the back quarter carries the rest.
    expect(points[1]!.forwardVol).toBeCloseTo(Math.sqrt((0.09 * 0.5 - 0.04 * 0.25) / 0.25), 12);
    expect(points[1]!.arbitrage).toBeUndefined();
  });

  it('is flat when the quotes are flat', () => {
    const points = termStructure(wasm, [
      { time: 0.25, vol: 0.3 },
      { time: 0.5, vol: 0.3 },
      { time: 1, vol: 0.3 },
    ]);
    for (const point of points.slice(1)) expect(point.forwardVol).toBeCloseTo(0.3, 12);
  });

  it('flags a calendar arbitrage rather than flattening it', () => {
    // More total variance at six months than at one year.
    const points = termStructure(wasm, [
      { time: 0.5, vol: 0.4, expiry: 'Jun' },
      { time: 1, vol: 0.25, expiry: 'Dec' },
    ]);
    expect(points[1]!.forwardVol).toBeUndefined();
    // "An explicit flag when the constraints cannot be satisfied, which is
    // itself information." A clamp to zero would look like a market view.
    expect(points[1]!.arbitrage).toContain('Jun');
    expect(points[1]!.arbitrage).toContain('Dec');
  });
});

describe('skew', () => {
  const base = { spot: 100, time: 0.25, rate: 0.045, dividend: 0.017 };

  /** A downward-sloping smile: puts bid, calls offered. The equity case. */
  const smile: SmileQuote[] = [
    { strike: 80, vol: 0.40, kind: 'put' },
    { strike: 88, vol: 0.35, kind: 'put' },
    { strike: 96, vol: 0.31, kind: 'put' },
    { strike: 100, vol: 0.30, kind: 'put' },
    { strike: 100, vol: 0.30, kind: 'call' },
    { strike: 104, vol: 0.29, kind: 'call' },
    { strike: 112, vol: 0.27, kind: 'call' },
    { strike: 120, vol: 0.26, kind: 'call' },
  ];

  it('reads a positive risk reversal off an equity smile', () => {
    const result = skew({ exports: wasm, quotes: smile, ...base });
    expect(result.putVol).toBeGreaterThan(result.callVol);
    expect(result.riskReversal).toBeGreaterThan(0);
    expect(result.delta).toBe(0.25);
    // The wings against the middle.
    expect(result.butterfly).toBeGreaterThan(0);
  });

  it('reads zero off a flat smile, at any delta', () => {
    const flat: SmileQuote[] = smile.map((q) => ({ ...q, vol: 0.3 }));
    // 0.10 is outside what these strikes quote on the call side, which the
    // refusal below is about; these three are inside on both.
    for (const delta of [0.2, 0.25, 0.4]) {
      const result = skew({ exports: wasm, quotes: flat, ...base, delta });
      expect(result.riskReversal).toBeCloseTo(0, 12);
      expect(result.butterfly).toBeCloseTo(0, 12);
      expect(result.atmVol).toBeCloseTo(0.3, 12);
    }
  });

  it('refuses to extrapolate past the quoted strikes', () => {
    // A 25-delta risk reversal read off strikes that stop at 35 delta is a
    // number about the interpolation.
    const narrow: SmileQuote[] = [
      { strike: 96, vol: 0.31, kind: 'put' },
      { strike: 100, vol: 0.30, kind: 'put' },
      { strike: 100, vol: 0.30, kind: 'call' },
      { strike: 104, vol: 0.29, kind: 'call' },
    ];
    expect(() => skew({ exports: wasm, quotes: narrow, ...base, delta: 0.05 })).toThrow(
      SmileTooNarrow,
    );
  });

  it('is read in delta space, so spot moving does not move it on its own', () => {
    // The reason a strike-space slope cannot be used for a history: it changes
    // when the underlier changes, with the smile unchanged. Shift the whole
    // smile with spot and the delta-space reading comes back the same.
    const at100 = skew({ exports: wasm, quotes: smile, ...base });
    const shifted: SmileQuote[] = smile.map((q) => ({ ...q, strike: q.strike * 1.1 }));
    const at110 = skew({ exports: wasm, quotes: shifted, ...base, spot: 110 });
    expect(at110.riskReversal).toBeCloseTo(at100.riskReversal, 6);
    expect(at110.atmVol).toBeCloseTo(at100.atmVol, 6);
  });
});

describe('the variance risk premium', () => {
  const dates = Array.from({ length: 23 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`);
  const closes = alternating(22, 0.006);

  it('compares the implied window with the realized one', () => {
    const result = variancePremium(wasm, {
      quotedAt: '2026-03-01',
      expiry: '2026-03-23',
      impliedVol: 0.25,
      closes,
      dates,
      periodsPerYear: TRADING_DAYS,
    });
    expect(result.observations).toBe(23);
    expect(result.impliedVariance).toBeCloseTo(0.0625, 12);
    expect(result.realizedVariance).toBeCloseTo(realizedVariance(wasm, closes), 12);
    expect(result.premium).toBeCloseTo(result.impliedVariance - result.realizedVariance, 12);
    expect(result.volSpread).toBeCloseTo(0.25 - Math.sqrt(result.realizedVariance), 12);
  });

  it('refuses a window that has not closed', () => {
    // Differencing today's implied against the trailing realized is a
    // different quantity, and one that often has the opposite sign.
    expect(() =>
      variancePremium(wasm, {
        quotedAt: '2026-03-01',
        expiry: '2026-04-30',
        impliedVol: 0.25,
        closes,
        dates,
      }),
    ).toThrow(WindowNotClosed);
  });

  it('uses only the closes inside the window', () => {
    const longer = { closes: [...closes, 999, 998], dates: [...dates, '2026-04-01', '2026-04-02'] };
    const inside = variancePremium(wasm, {
      quotedAt: '2026-03-01',
      expiry: '2026-03-23',
      impliedVol: 0.25,
      ...longer,
    });
    expect(inside.observations).toBe(23);
    expect(inside.realizedVariance).toBeCloseTo(realizedVariance(wasm, closes), 12);
  });
});

describe('the event-implied move', () => {
  const FIVE_DAYS = 5 / TRADING_DAYS;

  it('strips the diffusion out of the straddle', () => {
    const move = eventImpliedMove({
      exports: wasm,
      before: { time: FIVE_DAYS, vol: 0.30 },
      after: { time: FIVE_DAYS, vol: 0.55 },
    });
    // The naive reading is the whole expected move over those days.
    expect(move.move).toBeLessThan(move.straddleImplied);
    expect(move.diffusion).toBeCloseTo(0.0423, 4);
    expect(move.move).toBeCloseTo(Math.sqrt((0.55 ** 2 - 0.30 ** 2) * FIVE_DAYS), 12);
    // Most of what a naive reading would call the earnings move is diffusion.
    expect(move.diffusion / move.straddleImplied).toBeGreaterThan(0.5);
  });

  it('says nothing rather than zero when the quotes price no event', () => {
    for (const vol of [0.30, 0.28]) {
      expect(() =>
        eventImpliedMove({
          exports: wasm,
          before: { time: FIVE_DAYS, vol: 0.30 },
          after: { time: FIVE_DAYS, vol },
        }),
      ).toThrow(NoEventPremium);
    }
  });

  it('grows with the event premium and not with the quiet vol', () => {
    const quiet = eventImpliedMove({
      exports: wasm,
      before: { time: FIVE_DAYS, vol: 0.2 },
      after: { time: FIVE_DAYS, vol: 0.5 },
    });
    const busy = eventImpliedMove({
      exports: wasm,
      before: { time: FIVE_DAYS, vol: 0.2 },
      after: { time: FIVE_DAYS, vol: 0.7 },
    });
    expect(busy.move).toBeGreaterThan(quiet.move);
    const higherBase = eventImpliedMove({
      exports: wasm,
      before: { time: FIVE_DAYS, vol: 0.4 },
      after: { time: FIVE_DAYS, vol: 0.5 },
    });
    expect(higherBase.move).toBeLessThan(quiet.move);
  });
});
