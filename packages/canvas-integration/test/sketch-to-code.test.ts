/**
 * The sketch-to-code seam (PRD 3.7): a drawn payoff, candidate books from a
 * generator, and the verifier that decides which are offered.
 *
 * "A verifier node re-renders the produced payoff and compares against the ink
 * geometry (Fréchet distance under threshold) before the proposal is offered."
 * Re-rendering is `canvas-pricing`'s job and comparing is `canvas-ink`'s, and
 * the seam is that the curve the engine draws is the curve the verifier reads:
 * P&L up, spot across, in spot order. The generator is absent — no model runs
 * here — so the candidates are the kinds of answer one would give, right and
 * wrong.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Vec2 } from '@picasso/canvas-core';
import { SketchNotVerified, offerPayoffProposal, verifyPayoffSketch } from '@picasso/canvas-ink';
import { GridPricer, type Leg } from '@picasso/canvas-pricing';
import { loadPricing } from './load.js';
import { mulberry32 } from './strokes.js';

let pricer: GridPricer;

beforeAll(async () => {
  pricer = new GridPricer(await loadPricing());
});

const DAY = 1 / 365;
const market = { spot: 100, rate: 0.04, dividend: 0 };

function leg(strike: number, kind: 'call' | 'put', quantity: number): Leg {
  return { strike, time: DAY, kind, style: 'european', quantity, multiplier: 100, vol: 0.3 };
}

/** The candidate's payoff, drawn by the engine: value across spot the day before expiry. */
function render(book: Leg[]): Vec2[] {
  const result = pricer.reprice(book, market, { spotSteps: 81, spotRange: 0.4, volSteps: 1, volRange: 0 });
  return Array.from({ length: result.spotCount }, (_, s) => ({
    x: result.spotAxis[s]!,
    y: result.cell(s, 0).value,
  }));
}

/** A hand on a screen drawing a hockey stick: flat, then up and to the right. */
function drawnCall(seed: number): Vec2[] {
  const r = mulberry32(seed);
  const kink = 0.5 + (r() - 0.5) * 0.1;
  const n = 120;
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const rise = t < kink ? 0 : (t - kink) * 380;
    return { x: 50 + 400 * t, y: 320 - rise + 5 * Math.sin(t * 7 + r() * 0.2) };
  });
}

const candidates: Record<string, Leg[]> = {
  'long call': [leg(100, 'call', 1)],
  'bull call spread': [leg(100, 'call', 1), leg(115, 'call', -1)],
  'short call': [leg(100, 'call', -1)],
  'long put': [leg(100, 'put', 1)],
  'two long and one short of the same call': [leg(100, 'call', 2), leg(100, 'call', -1)],
};

describe('a drawn long call, and five generated answers', () => {
  it('offers the answers that draw what was drawn, and only those', () => {
    const ink = drawnCall(11);
    const offered: string[] = [];
    const refused: string[] = [];
    for (const [name, book] of Object.entries(candidates)) {
      try {
        offerPayoffProposal(name, { ink, inkYAxis: 'down', payoff: render(book) });
        offered.push(name);
      } catch (error) {
        expect(error).toBeInstanceOf(SketchNotVerified);
        refused.push(name);
      }
    }
    // Two lots long and one short of the same call is one long call: a
    // different book, the same shape, and it is offered. That is the verifier
    // judging the payoff rather than the code, which is what it is for.
    expect(offered.sort()).toEqual(['long call', 'two long and one short of the same call']);
    expect(refused.sort()).toEqual(['bull call spread', 'long put', 'short call']);
  });

  it('reads the engine’s curve the right way up', () => {
    // The engine's value axis grows upward. Were the verifier to treat it as
    // screen space, the short call would be the one offered.
    const ink = drawnCall(11);
    const short = verifyPayoffSketch({ ink, inkYAxis: 'down', payoff: render(candidates['short call']!) });
    const long = verifyPayoffSketch({ ink, inkYAxis: 'down', payoff: render(candidates['long call']!) });
    expect(long.distance).toBeLessThan(short.distance);
    expect(short.matches).toBe(false);
  });
});
