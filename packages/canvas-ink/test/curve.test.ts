import { describe, expect, it } from 'vitest';
import {
  JITTER_PX,
  StrokeIsNotACurve,
  describeCurveShock,
  engineShockPoints,
  strokeToCurveShock,
  type CurveFrame,
  type CurvePin,
} from '../src/curve.js';
import type { InkStroke } from '../src/stroke.js';

/**
 * A chart 800px wide and 400px tall: 0 to 30 years across, 2% to 6% down.
 * Rate increases upward, which is why `yAtRate` subtracts.
 */
const frame: CurveFrame = {
  xAtTenor: (tenor) => (tenor / 30) * 800,
  yAtRate: (rate) => 400 - ((rate - 0.02) / 0.04) * 400,
  rateAtY: (y) => 0.02 + ((400 - y) / 400) * 0.04,
};

/** An upward-sloping curve, the one the analyst is drawing over. */
const pins: CurvePin[] = [
  { label: '1Y', tenor: 1, rate: 0.035 },
  { label: '2Y', tenor: 2, rate: 0.0365 },
  { label: '5Y', tenor: 5, rate: 0.039 },
  { label: '10Y', tenor: 10, rate: 0.042 },
  { label: '30Y', tenor: 30, rate: 0.045 },
];

/** A stroke through a function of tenor: one rate per x, sampled densely. */
function drawn(rateAt: (tenor: number) => number, from = 0, to = 30, samples = 200): InkStroke {
  const points = Array.from({ length: samples }, (_, i) => {
    const tenor = from + ((to - from) * i) / (samples - 1);
    return { x: frame.xAtTenor(tenor), y: frame.yAtRate(rateAt(tenor)), pressure: 0.5, t: i * 8 };
  });
  return { id: 's1', runs: [{ points }], committed: true };
}

/** The curve as it is: linear between the pins. */
function current(tenor: number): number {
  let previous = pins[0]!;
  for (const pin of pins) {
    if (pin.tenor >= tenor) {
      if (pin.tenor === previous.tenor) return pin.rate;
      const weight = (tenor - previous.tenor) / (pin.tenor - previous.tenor);
      return previous.rate + weight * (pin.rate - previous.rate);
    }
    previous = pin;
  }
  return previous.rate;
}

describe('reading a drawn curve', () => {
  it('reads a traced line as no shock at all', () => {
    // The property that makes the gesture legible: drawing over the curve
    // moves nothing. A non-zero answer here would mean the recognizer and the
    // renderer disagree about where the curve is.
    const reading = strokeToCurveShock(drawn(current), frame, pins, 'USD');
    // Within a basis point, which is the pen's own resolution on this chart: a
    // kink falling between two samples is read across rather than through, and
    // at this sampling that is worth one bp at 1Y, where the curve bends most.
    for (const bps of Object.values(reading.shock.tenorDeltasBps)) {
      expect(Math.abs(bps)).toBeLessThanOrEqual(1);
    }
    expect(reading.uncovered).toEqual([]);
  });

  it('reads a parallel lift as the same move at every tenor', () => {
    const reading = strokeToCurveShock(drawn((t) => current(t) + 0.005), frame, pins, 'USD');
    for (const bps of Object.values(reading.shock.tenorDeltasBps)) {
      expect(Math.abs(bps - 50)).toBeLessThanOrEqual(1);
    }
    expect(reading.shock.currency).toBe('USD');
  });

  it('reads a steepener as a pivot', () => {
    // Front pinned, back up 60bp, straight line between.
    const reading = strokeToCurveShock(
      drawn((t) => current(t) + 0.006 * (t / 30)),
      frame,
      pins,
      'USD',
    );
    const deltas = reading.shock.tenorDeltasBps;
    expect(deltas['1Y']).toBeLessThanOrEqual(3);
    expect(deltas['30Y']).toBe(60);
    expect(deltas['10Y']).toBeGreaterThan(deltas['2Y']!);
  });

  it('rounds to whole basis points, and says what a pixel was worth', () => {
    const reading = strokeToCurveShock(drawn((t) => current(t) + 0.00047), frame, pins, 'USD');
    // 4.7bp from a gesture is a precision the hand does not have.
    for (const bps of Object.values(reading.shock.tenorDeltasBps)) {
      expect(Math.abs(bps - 5)).toBeLessThanOrEqual(1);
    }
    // 4 percentage points over 400 pixels: one pixel is one basis point.
    expect(reading.resolutionBps).toBeCloseTo(1, 9);
  });
});

describe('what it refuses', () => {
  it('refuses a stroke that doubles back', () => {
    const forward = drawn(current, 0, 20, 100).runs[0]!.points;
    const back = drawn(current, 20, 12, 40).runs[0]!.points;
    const stroke: InkStroke = { id: 's2', runs: [{ points: [...forward, ...back] }] };
    // Two rates on one tenor, and nothing here can tell which one was meant.
    expect(() => strokeToCurveShock(stroke, frame, pins, 'USD')).toThrow(StrokeIsNotACurve);
    try {
      strokeToCurveShock(stroke, frame, pins, 'USD');
    } catch (error) {
      expect((error as StrokeIsNotACurve).reason).toBe('not_monotonic');
    }
  });

  it('tolerates pen jitter, which is not a reversal', () => {
    const points = drawn(current).runs[0]!.points.map((p, i) => ({
      ...p,
      x: i % 7 === 0 ? p.x - JITTER_PX : p.x,
    }));
    expect(() =>
      strokeToCurveShock({ id: 's3', runs: [{ points }] }, frame, pins, 'USD'),
    ).not.toThrow();
  });

  it('refuses a stroke with nothing in it', () => {
    expect(() => strokeToCurveShock({ id: 's4', runs: [] }, frame, pins, 'USD')).toThrow(
      /too short|1 sample|0 sample/i,
    );
  });

  it('leaves a tenor the stroke did not cross out of the shock entirely', () => {
    // The convenient thing is to extend the ends flat. That writes a *zero*
    // delta, which in a curve shock means "held here" — the strongest claim on
    // the chart, and one the analyst did not make.
    const reading = strokeToCurveShock(drawn((t) => current(t) + 0.004, 3, 12), frame, pins, 'USD');
    expect(Object.keys(reading.shock.tenorDeltasBps)).toEqual(['5Y', '10Y']);
    expect(reading.uncovered).toEqual(['1Y', '2Y', '30Y']);
    expect('1Y' in reading.shock.tenorDeltasBps).toBe(false);
  });

  it('reports a stroke that crosses no tenor at all', () => {
    const reading = strokeToCurveShock(drawn(current, 11, 12), frame, pins, 'USD');
    expect(reading.shock.tenorDeltasBps).toEqual({});
    expect(describeCurveShock(reading)).toContain('does not cross any tenor');
  });
});

describe('the affordance', () => {
  it('describes the shock in words, signed', () => {
    const reading = strokeToCurveShock(drawn((t) => current(t) + 0.005, 0, 12), frame, pins, 'USD');
    const description = describeCurveShock(reading);
    expect(description).toContain('1Y +50bp');
    // Nothing auto-promotes: the analyst confirms this, so it has to read.
    expect(description).toContain('30Y not drawn, and left alone');
  });

  it('signs a downward draw', () => {
    const reading = strokeToCurveShock(drawn((t) => current(t) - 0.0025), frame, pins, 'USD');
    expect(describeCurveShock(reading)).toContain('10Y -25bp');
  });
});

describe('handing the reading to a curve engine', () => {
  it('writes every undrawn pin as an explicit zero', () => {
    // The reading keeps them absent, which is right for composing scenarios.
    // An engine that holds end values flat needs to be told the long end did
    // not move, or it moves it by whatever was drawn at 10Y.
    const reading = strokeToCurveShock(drawn((t) => current(t) + 0.004, 3, 12), frame, pins, 'USD');
    expect(engineShockPoints(reading, pins)).toEqual([
      { tenor: 1, bps: 0 },
      { tenor: 2, bps: 0 },
      { tenor: 5, bps: reading.shock.tenorDeltasBps['5Y'] },
      { tenor: 10, bps: reading.shock.tenorDeltasBps['10Y'] },
      { tenor: 30, bps: 0 },
    ]);
  });

  it('orders the points by tenor whatever order the pins came in', () => {
    const shuffled = [pins[3]!, pins[0]!, pins[4]!, pins[1]!, pins[2]!];
    const reading = strokeToCurveShock(drawn((t) => current(t) + 0.002), frame, shuffled, 'USD');
    const tenors = engineShockPoints(reading, shuffled).map((p) => p.tenor);
    expect(tenors).toEqual([1, 2, 5, 10, 30]);
  });
});
