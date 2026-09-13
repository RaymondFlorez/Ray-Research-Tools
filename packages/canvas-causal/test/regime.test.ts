import { describe, expect, it } from 'vitest';
import { detectSplit, estimateWithRegimes, MIN_SEGMENT } from '../src/regime.js';

function rng(seed = 11) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 - 0.5;
  };
}

/** A relationship that changes slope partway through, as a regime change looks. */
function broken(n: number, breakAt: number, before: number, after: number, noise = 0.2) {
  const random = rng();
  const x: number[] = [];
  const y: number[] = [];
  for (let t = 0; t < n; t += 1) {
    const shock = random() * 2;
    x.push(shock);
    const beta = t < breakAt ? before : after;
    y.push(beta * shock + random() * noise);
  }
  return { x, y };
}

describe('the regime split', () => {
  it('finds a break where there is one', () => {
    const { x, y } = broken(400, 200, 2.0, -1.0);
    const split = detectSplit(x, y);
    expect(split.detected).toBe(true);
    expect(Math.abs(split.at - 200)).toBeLessThan(20);
    expect(split.improvement).toBeGreaterThan(50);
  });

  /**
   * The claim from PRD 5.6: "a single elasticity averaged across a structural
   * break is usually the most confidently wrong number on the canvas."
   *
   * This is that sentence as a test. The two regimes are +2.0 and −1.0; the
   * full-sample estimate lands between them, at a value neither regime ever
   * took, and the node has to say so.
   */
  it('flags a number that is the average of two regimes and true in neither', () => {
    const { x, y } = broken(400, 200, 2.0, -1.0);
    const result = estimateWithRegimes(x, y, 0);
    expect(result).toBeDefined();
    if (!result) return;

    expect(result.before?.value).toBeCloseTo(2.0, 1);
    expect(result.after?.value).toBeCloseTo(-1.0, 1);
    // The full-sample number sits between them and describes neither.
    expect(result.full.value).toBeGreaterThan(-1.0);
    expect(result.full.value).toBeLessThan(2.0);

    expect(result.unstable).toBe(true);
    expect(result.warning).toContain('average of two regimes');
    expect(result.warning).toContain('not an estimate of either');
  });

  it('leaves a stable relationship alone', () => {
    const { x, y } = broken(400, 200, 1.5, 1.5);
    const result = estimateWithRegimes(x, y, 0);
    expect(result?.unstable).toBe(false);
    expect(result?.warning).toBeUndefined();
    // And the full-sample estimate is the right one to use.
    expect(result?.full.value).toBeCloseTo(1.5, 1);
  });

  it('takes a break the analyst knows about, and says it was given', () => {
    const { x, y } = broken(400, 200, 2.0, -1.0);
    const supplied = estimateWithRegimes(x, y, 0, { splitAt: 200 });
    expect(supplied?.split.detected).toBe(false);
    expect(supplied?.split.at).toBe(200);
    // It still reports how well the data supports that date, so a break someone
    // picked can be checked against one the data would have picked.
    expect(supplied?.split.improvement).toBeGreaterThan(50);
    expect(supplied?.unstable).toBe(true);
  });

  it('will not split a sample into slivers', () => {
    const { x, y } = broken(400, 200, 2.0, -1.0);
    const split = detectSplit(x, y);
    expect(split.at).toBeGreaterThanOrEqual(MIN_SEGMENT);
    expect(split.at).toBeLessThanOrEqual(400 - MIN_SEGMENT);

    // A sample too short to hold two regimes reports the full estimate alone.
    const tiny = broken(60, 30, 2.0, -1.0);
    const result = estimateWithRegimes(tiny.x, tiny.y, 0, { splitAt: 5 });
    expect(result?.before).toBeUndefined();
    expect(result?.after).toBeUndefined();
    expect(result?.unstable).toBe(false);
  });

  it('does not invent a break in noise', () => {
    const random = rng(3);
    const x = Array.from({ length: 400 }, () => random());
    const y = Array.from({ length: 400 }, () => random());
    // Something will always fit two halves slightly better than one; what
    // matters is that it stays far below the threshold. `calibration.test.ts`
    // is where that margin is measured.
    expect(detectSplit(x, y).improvement).toBeLessThan(8);
    expect(estimateWithRegimes(x, y, 0)?.unstable).toBe(false);
  });
});
