import { describe, expect, it } from 'vitest';
import { impulseResponse, localProjection } from '../src/estimate.js';

/** Deterministic uniform noise, so a failure is reproducible. */
function rng(seed = 7) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648 - 0.5;
  };
}

/**
 * A series where `y` responds to `x` with a known shape: nothing on impact,
 * building to a peak at horizon 3, then decaying. That shape is what an impulse
 * response is supposed to recover.
 */
function world(n = 600, noise = 0.3) {
  const random = rng();
  const response = [0, 0.4, 0.9, 1.4, 1.0, 0.6, 0.3, 0.1];
  const x: number[] = [];
  const y: number[] = [];
  for (let t = 0; t < n; t += 1) {
    x.push(random() * 2);
    let value = random() * noise;
    for (let h = 0; h < response.length; h += 1) {
      if (t - h >= 0) value += (response[h] as number) * (x[t - h] as number);
    }
    y.push(value);
  }
  return { x, y, response };
}

describe('local projection', () => {
  it('recovers the response it was given, horizon by horizon', () => {
    const { x, y, response } = world();
    for (let h = 0; h < response.length; h += 1) {
      const fit = localProjection(x, y, h);
      expect(fit, `horizon ${h}`).toBeDefined();
      if (!fit) continue;
      expect(fit.value).toBeCloseTo(response[h] as number, 1);
    }
  });

  it('finds the peak where the peak is', () => {
    const { x, y } = world();
    const irf = impulseResponse(x, y, { horizons: [0, 1, 2, 3, 4, 5, 6, 7] });
    expect(irf?.peakHorizon).toBe(3);
    expect(irf?.peak.value).toBeCloseTo(1.4, 1);
  });

  it('says nothing rather than fitting a sample it does not have', () => {
    expect(localProjection([1, 2, 3], [1, 2, 3], 0)).toBeUndefined();
    // A long horizon eats the sample from the other end.
    const { x, y } = world(40);
    expect(localProjection(x, y, 30)).toBeUndefined();
  });

  it('refuses a collinear design rather than returning a number', () => {
    // x constant: after the constant column there is nothing left to identify.
    const x = new Array<number>(300).fill(1);
    const y = Array.from({ length: 300 }, (_, t) => t * 0.01);
    expect(localProjection(x, y, 1)).toBeUndefined();
  });

  /**
   * The reason Appendix C.3 specifies Newey-West rather than leaving it open.
   *
   * A horizon-h projection has residuals that are MA(h) by construction — the
   * same shock appears in h overlapping windows — so an ordinary standard error
   * is too small, and too small in the direction that makes a weak edge look
   * strong. The correction has to grow with the horizon, and this checks that
   * it does.
   */
  it('widens the standard error as the horizon overlaps more', () => {
    const { x, y } = world(800, 1.0);
    const short = localProjection(x, y, 0);
    const long = localProjection(x, y, 10);
    expect(short).toBeDefined();
    expect(long).toBeDefined();
    if (!short || !long) return;
    expect(long.bandwidth).toBeGreaterThan(short.bandwidth);
    expect(long.standardError).toBeGreaterThan(short.standardError);
  });

  it('reports a wide error and a low R² when there is no relationship', () => {
    const random = rng(99);
    const x = Array.from({ length: 500 }, () => random());
    const y = Array.from({ length: 500 }, () => random());
    const fit = localProjection(x, y, 2);
    expect(fit).toBeDefined();
    if (!fit) return;
    // The estimate cannot be distinguished from zero, and says so.
    expect(Math.abs(fit.tStatistic)).toBeLessThan(2);
    expect(fit.rSquared).toBeLessThan(0.2);
  });

  it('is more certain with more data, which is the only free lunch', () => {
    const small = localProjection(...seriesOf(200), 2);
    const large = localProjection(...seriesOf(1600), 2);
    expect(small).toBeDefined();
    expect(large).toBeDefined();
    if (!small || !large) return;
    expect(large.standardError).toBeLessThan(small.standardError);
  });
});

function seriesOf(n: number): [number[], number[]] {
  const { x, y } = world(n);
  return [x, y];
}
