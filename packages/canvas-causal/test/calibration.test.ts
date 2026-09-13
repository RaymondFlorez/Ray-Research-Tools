import { describe, expect, it } from 'vitest';
import {
  detectSplit,
  estimateWithRegimes,
  INSTABILITY_T,
  SEARCHED_BREAK_F,
} from '../src/regime.js';

function rng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 - 0.5;
  };
}

/**
 * What sets `SEARCHED_BREAK_F`, kept as a test so the constant stays honest.
 *
 * `detectSplit` returns the best of roughly 350 candidate breakpoints. The
 * distribution of that maximum under the null is what the threshold has to
 * clear, and it is nothing like the distribution of a single pre-specified
 * test — which is the mistake this file exists to prevent from coming back.
 */
describe('calibrating the break detector against the null', () => {
  it('stays well under the threshold when nothing is broken', () => {
    for (const [label, beta] of [['pure noise', 0], ['stable slope', 1.5]] as const) {
      const improvements: number[] = [];
      const gaps: number[] = [];
      for (let trial = 0; trial < 40; trial += 1) {
        const random = rng(1000 + trial * 37);
        const x: number[] = [];
        const y: number[] = [];
        for (let t = 0; t < 400; t += 1) {
          const shock = random() * 2;
          x.push(shock);
          y.push(beta * shock + random() * 0.2);
        }
        improvements.push(detectSplit(x, y).improvement);
        const r = estimateWithRegimes(x, y, 0);
        if (r?.before && r.after) {
          gaps.push(
            Math.abs(r.after.value - r.before.value) /
              Math.hypot(r.before.standardError, r.after.standardError),
          );
        }
      }
      improvements.sort((a, b) => a - b);
      gaps.sort((a, b) => a - b);
      const q = (v: number[], p: number) => v[Math.floor(v.length * p)]?.toFixed(2);
      console.log(
        `${label.padEnd(14)} improvement p50 ${q(improvements, 0.5)} p95 ${q(improvements, 0.95)} max ${improvements.at(-1)?.toFixed(2)}` +
          `   |t| p50 ${q(gaps, 0.5)} p95 ${q(gaps, 0.95)} max ${gaps.at(-1)?.toFixed(2)}`,
      );

      // The threshold has to sit above everything the null produces, or the
      // detector reports breaks in data that has none.
      expect(improvements.at(-1)).toBeLessThan(SEARCHED_BREAK_F);

      // And this is why the coefficient gap cannot be the test for a searched
      // break: under the null it clears two standard errors routinely.
      expect(gaps[Math.floor(gaps.length * 0.5)]).toBeGreaterThan(1);
      expect(gaps.at(-1)).toBeGreaterThan(INSTABILITY_T);
    }
  });
});
