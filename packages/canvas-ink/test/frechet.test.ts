import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@picasso/canvas-core';
import {
  PAYOFF_TOLERANCE,
  SketchNotVerified,
  discreteFrechet,
  normalizeToUnit,
  offerPayoffProposal,
  verifyPayoffSketch,
} from '../src/frechet.js';
import { mulberry32 } from './synth.js';

/** Every coupling of two short polylines, enumerated: the definition, brute force. */
function bruteFrechet(a: readonly Vec2[], b: readonly Vec2[]): number {
  const d = (i: number, j: number) => Math.hypot(a[i]!.x - b[j]!.x, a[i]!.y - b[j]!.y);
  let best = Infinity;
  const walk = (i: number, j: number, worst: number) => {
    const w = Math.max(worst, d(i, j));
    if (w >= best) return;
    if (i === a.length - 1 && j === b.length - 1) {
      best = w;
      return;
    }
    if (i + 1 < a.length) walk(i + 1, j, w);
    if (j + 1 < b.length) walk(i, j + 1, w);
    if (i + 1 < a.length && j + 1 < b.length) walk(i + 1, j + 1, w);
  };
  walk(0, 0, 0);
  return best;
}

function payoff(f: (s: number) => number): Vec2[] {
  return Array.from({ length: 121 }, (_, i) => {
    const s = 60 + (i * 80) / 120;
    return { x: s, y: f(s) };
  });
}

const K = 100;
const LONG_CALL = payoff((s) => Math.max(s - K, 0) - 5);
const BULL_SPREAD = payoff((s) => Math.min(Math.max(s - K, 0), 20) - 5);
const SHORT_CALL = payoff((s) => -Math.max(s - K, 0) + 5);
const LONG_PUT = payoff((s) => Math.max(K - s, 0) - 5);
const STRADDLE = payoff((s) => Math.abs(s - K) - 8);
const SHORT_PUT = payoff((s) => -Math.max(K - s, 0) + 5);

/**
 * A hand drawing a hockey stick on screen, y down: flat, then up and right,
 * with the kink misplaced by up to six percent of the width, a slope that is
 * not quite one, slow tremor, and a varying number of samples.
 */
function handDrawnCall(seed: number): Vec2[] {
  const r = mulberry32(seed);
  const kink = 0.5 + (r() - 0.5) * 0.12;
  const slope = 0.8 + r() * 0.5;
  const amplitude = 4 + r() * 4;
  const p1 = r() * 6;
  const p2 = r() * 6;
  const n = 80 + Math.floor(r() * 80);
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const rise = t < kink ? 0 : (t - kink) * 400 * slope;
    const wobble = amplitude * (Math.sin(t * Math.PI * 2 + p1) * 0.7 + Math.sin(t * Math.PI * 5 + p2) * 0.3);
    return { x: 40 + 400 * t, y: 300 - rise + wobble };
  });
}

describe('discrete Fréchet', () => {
  it('matches a brute-force enumeration of every coupling', () => {
    const r = mulberry32(9);
    for (let trial = 0; trial < 30; trial++) {
      const a = Array.from({ length: 2 + Math.floor(r() * 5) }, () => ({ x: r() * 10, y: r() * 10 }));
      const b = Array.from({ length: 2 + Math.floor(r() * 5) }, () => ({ x: r() * 10, y: r() * 10 }));
      expect(discreteFrechet(a, b)).toBeCloseTo(bruteFrechet(a, b), 12);
    }
  });

  it('is zero on identical curves and symmetric', () => {
    expect(discreteFrechet(LONG_CALL, LONG_CALL)).toBe(0);
    expect(discreteFrechet(LONG_CALL, BULL_SPREAD)).toBe(discreteFrechet(BULL_SPREAD, LONG_CALL));
  });

  it('respects order, which the nearest-point distance does not', () => {
    // The same three points, visited in a different order: every point of one
    // is on the other, so the Hausdorff distance is zero. The walk is not.
    const a = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
    const b = [{ x: 2, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 0 }];
    expect(discreteFrechet(a, b)).toBe(2);
  });
});

describe('normalization', () => {
  it('maps a curve into the unit square', () => {
    const unit = normalizeToUnit(LONG_CALL);
    expect(Math.min(...unit.map((p) => p.x))).toBe(0);
    expect(Math.max(...unit.map((p) => p.x))).toBe(1);
    expect(Math.min(...unit.map((p) => p.y))).toBe(0);
    expect(Math.max(...unit.map((p) => p.y))).toBe(1);
  });

  it('keeps a flat curve flat rather than stretching noise into a wall', () => {
    const flat = normalizeToUnit([{ x: 0, y: 3 }, { x: 5, y: 3 }, { x: 10, y: 3 }]);
    expect(flat.map((p) => p.y)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('verifying a sketched payoff', () => {
  const score = (payoffCurve: Vec2[]) =>
    Array.from({ length: 50 }, (_, i) =>
      verifyPayoffSketch({ ink: handDrawnCall(i + 1), inkYAxis: 'down', payoff: payoffCurve }).distance,
    );

  it('accepts fifty hand-drawn long calls, the worst at 0.072', () => {
    const d = score(LONG_CALL);
    expect(Math.max(...d)).toBeLessThan(0.075);
    expect(Math.max(...d)).toBeLessThan(PAYOFF_TOLERANCE);
  });

  it('rejects the nearest wrong shape, a bull call spread, every time', () => {
    // The cap is the only thing that tells it apart, and it is enough:
    // 0.210 at the closest, against a tolerance of 0.15.
    const d = score(BULL_SPREAD);
    expect(Math.min(...d)).toBeGreaterThan(0.2);
  });

  it('rejects everything further away by a wide margin', () => {
    for (const wrong of [SHORT_CALL, LONG_PUT, STRADDLE, SHORT_PUT]) {
      expect(Math.min(...score(wrong))).toBeGreaterThan(0.4);
    }
  });

  it('treats getting the ink axis wrong as the mirror image it is', () => {
    // Screen coordinates grow downward. Read as if they grew upward, a drawn
    // long call is a short call, and matches nothing it was meant to.
    const ink = handDrawnCall(3);
    expect(verifyPayoffSketch({ ink, inkYAxis: 'down', payoff: LONG_CALL }).matches).toBe(true);
    expect(verifyPayoffSketch({ ink, inkYAxis: 'up', payoff: LONG_CALL }).matches).toBe(false);
    expect(verifyPayoffSketch({ ink, inkYAxis: 'up', payoff: SHORT_CALL }).matches).toBe(true);
  });

  it('does not care which way the pen travelled', () => {
    const ink = [...handDrawnCall(3)].reverse();
    expect(verifyPayoffSketch({ ink, inkYAxis: 'down', payoff: LONG_CALL }).matches).toBe(true);
  });
});

describe('the offer', () => {
  it('offers a candidate that draws what was drawn', () => {
    const offer = offerPayoffProposal('long 1x K=100 call', {
      ink: handDrawnCall(7),
      inkYAxis: 'down',
      payoff: LONG_CALL,
    });
    expect(offer.candidate).toBe('long 1x K=100 call');
    expect(offer.verdict.matches).toBe(true);
  });

  it('never offers one that does not, not even with a warning', () => {
    expect(() =>
      offerPayoffProposal('bull call spread 100/120', {
        ink: handDrawnCall(7),
        inkYAxis: 'down',
        payoff: BULL_SPREAD,
      }),
    ).toThrow(SketchNotVerified);
  });
});
