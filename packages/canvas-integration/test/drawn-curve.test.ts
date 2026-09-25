/**
 * The drawn-curve seam: a pen stroke becoming a shocked curve (PRD 5.3).
 *
 * "The analyst can literally draw the shocked curve with the pen and the
 * ink-to-curve recognizer converts the stroke to tenor-point deltas."
 *
 * `canvas-ink` reads the stroke and `pricing-core` applies the deltas, and the
 * two disagree about one word. The recognizer keeps a tenor the stroke did not
 * cross *absent*, and tells the analyst it is "left alone". The engine holds
 * a shock's end values flat beyond its last point. Hand one to the other
 * directly and a stroke that stopped at 10y moves the 30y rate by whatever was
 * drawn at 10y — after the analyst confirmed a description saying it would
 * not move. Each package is right about its own half.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  engineShockPoints,
  describeCurveShock,
  strokeToCurveShock,
  type CurveFrame,
  type CurvePin,
  type InkStroke,
} from '@picasso/canvas-ink';
import { CurveEngine, STANDARD_TENORS, type Curve, type Instrument } from '@picasso/canvas-pricing';
import { loadPricing } from './load.js';

const INSTRUMENTS: Instrument[] = [
  { kind: 'deposit', maturity: 0.25, rate: 0.0425 },
  { kind: 'deposit', maturity: 0.5, rate: 0.0432 },
  { kind: 'deposit', maturity: 1, rate: 0.0441 },
  { kind: 'swap', maturity: 2, rate: 0.0438, frequency: 2 },
  { kind: 'swap', maturity: 5, rate: 0.0421, frequency: 2 },
  { kind: 'swap', maturity: 10, rate: 0.0417, frequency: 2 },
  { kind: 'swap', maturity: 30, rate: 0.0431, frequency: 2 },
];

/** The chart the curve is drawn on: 0-30y across 900px, 3%-6% down 600px. */
const frame: CurveFrame = {
  xAtTenor: (tenor) => (tenor / 30) * 900,
  yAtRate: (rate) => 600 - ((rate - 0.03) / 0.03) * 600,
  rateAtY: (y) => 0.03 + ((600 - y) / 600) * 0.03,
};

let curves: CurveEngine;
let base: Curve;
let pins: CurvePin[];

beforeAll(async () => {
  curves = new CurveEngine(await loadPricing());
  base = curves.bootstrap(INSTRUMENTS);
  // The pins are the chart's own reading of the curve the analyst is drawing
  // over — the engine's zero rates, not a second copy of them.
  pins = STANDARD_TENORS.map((tenor) => ({ label: `${tenor}Y`, tenor, rate: base.zero(tenor) }));
});

/** A stroke over the curve, lifted by `bps(t)`, from `from` to `to` years. */
function stroke(bps: (tenor: number) => number, from: number, to: number): InkStroke {
  const samples = 240;
  const points = Array.from({ length: samples }, (_, i) => {
    const tenor = from + ((to - from) * i) / (samples - 1);
    const rate = base.zero(Math.max(tenor, 0.01)) + bps(tenor) / 10_000;
    return { x: frame.xAtTenor(tenor), y: frame.yAtRate(rate), pressure: 0.5, t: i * 8 };
  });
  return { id: 'pen', runs: [{ points }], committed: true };
}

describe('a drawn belly shock, from the pen to the engine', () => {
  // Up 40bp through the belly, drawn from 3y to 10y only.
  const belly = () => 40;

  it('moves the drawn tenors by what was drawn', () => {
    const reading = strokeToCurveShock(stroke(belly, 3, 10), frame, pins, 'USD');
    const shocked = curves.shocked(INSTRUMENTS, {
      shape: 'custom',
      points: engineShockPoints(reading, pins),
    });
    for (const tenor of [3, 5, 7, 10]) {
      const moved = (shocked.zero(tenor) - base.zero(tenor)) * 10_000;
      // The pen resolves this chart to 0.5bp a pixel and the reading rounds
      // to whole basis points, so a drawn 40 reaches the engine as 40 +/- 1.
      expect(Math.abs(moved - 40)).toBeLessThanOrEqual(1);
    }
  });

  it('leaves the tenors it said it would leave alone exactly where they were', () => {
    const reading = strokeToCurveShock(stroke(belly, 3, 10), frame, pins, 'USD');
    // What the analyst confirmed before applying it.
    expect(describeCurveShock(reading)).toContain('30Y');
    expect(describeCurveShock(reading)).toContain('left alone');

    const shocked = curves.shocked(INSTRUMENTS, {
      shape: 'custom',
      points: engineShockPoints(reading, pins),
    });
    for (const tenor of [0.25, 0.5, 1, 2, 20, 30]) {
      expect(shocked.zero(tenor)).toBeCloseTo(base.zero(tenor), 12);
    }
  });

  it('is exactly the bug it looks like without the explicit zeros', () => {
    // The two packages handed to each other directly: only the drawn points.
    const reading = strokeToCurveShock(stroke(belly, 3, 10), frame, pins, 'USD');
    const drawnOnly = pins
      .filter((pin) => pin.label in reading.shock.tenorDeltasBps)
      .map((pin) => ({ tenor: pin.tenor, bps: reading.shock.tenorDeltasBps[pin.label]! }));
    const shocked = curves.shocked(INSTRUMENTS, { shape: 'custom', points: drawnOnly });
    const longEnd = (shocked.zero(30) - base.zero(30)) * 10_000;
    const frontEnd = (shocked.zero(0.25) - base.zero(0.25)) * 10_000;
    // Flat beyond the last point: the long end moves by what was drawn at 10y,
    // the front end by what was drawn at 3y. Neither was drawn.
    expect(Math.abs(longEnd - 40)).toBeLessThanOrEqual(1);
    expect(Math.abs(frontEnd - 40)).toBeLessThanOrEqual(1);
  });

  it('refuses a drawn shock with its points out of order, in the engine', () => {
    expect(() =>
      curves.shocked(INSTRUMENTS, {
        shape: 'custom',
        points: [
          { tenor: 10, bps: 5 },
          { tenor: 2, bps: 5 },
        ],
      }),
    ).toThrow(/strictly increasing/);
  });
});
