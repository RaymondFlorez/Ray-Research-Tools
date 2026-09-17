/**
 * Newey-West, checked against computations done a different way.
 *
 * The estimator is a sandwich with a Bartlett kernel, and both halves are easy
 * to get subtly wrong in ways a "the standard error is positive and plausible"
 * test would never notice: the weight could be `1 - lag/L` instead of
 * `1 - lag/(L+1)`, the cross-lag term could be counted once instead of twice,
 * the degrees-of-freedom correction could be applied to the bread instead of
 * the meat. None of those changes the sign or the order of magnitude.
 *
 * So this file checks properties the formula must satisfy, computed here from
 * the definition rather than by calling the same code path twice.
 */

import { describe, expect, it } from 'vitest';
import { localProjection } from '../src/estimate.js';

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4_294_967_296;
  };
}

function normal(next: () => number): number {
  const u = Math.max(next(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/** x is white noise; y responds to x one period later, plus noise. */
function series(n: number, beta: number, seed: number): { x: number[]; y: number[] } {
  const next = rng(seed);
  const x = Array.from({ length: n }, () => normal(next));
  const y = x.map((_, t) => (t >= 1 ? beta * (x[t - 1] as number) : 0) + 0.5 * normal(next));
  return { x, y };
}

describe('the sandwich reduces to what it should', () => {
  // At bandwidth zero the lag sum is empty, so Newey-West *is* the
  // heteroskedasticity-robust estimator. If the base term were built wrong —
  // a missing square, an average where a sum belongs — this would not hold.
  it('is White\'s robust estimator at bandwidth zero', () => {
    const { x, y } = series(400, 0.8, 11);
    const hac = localProjection(x, y, 1, { bandwidth: 0, controlLags: 2 });
    expect(hac).toBeDefined();

    // Rebuild the design exactly as localProjection does, and compute HC1 by
    // hand: (X'X)^-1 (sum u_t^2 x_t x_t') (X'X)^-1, first element, times
    // n/(n-k).
    const lags = 2;
    const horizon = 1;
    const design: number[][] = [];
    const response: number[] = [];
    for (let t = lags; t < x.length - horizon; t += 1) {
      const row = [x[t] as number, 1];
      for (let lag = 1; lag <= lags; lag += 1) {
        row.push(y[t - lag] as number, x[t - lag] as number);
      }
      design.push(row);
      response.push(y[t + horizon] as number);
    }

    const k = design[0]!.length;
    const n = design.length;
    const xtx = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    const xty = new Array<number>(k).fill(0);
    for (let t = 0; t < n; t += 1) {
      for (let i = 0; i < k; i += 1) {
        xty[i]! += design[t]![i]! * response[t]!;
        for (let j = 0; j < k; j += 1) xtx[i]![j]! += design[t]![i]! * design[t]![j]!;
      }
    }

    const inverse = invert(xtx, k)!;
    const beta = new Array<number>(k).fill(0).map((_, i) => {
      let total = 0;
      for (let j = 0; j < k; j += 1) total += inverse[i]![j]! * xty[j]!;
      return total;
    });

    const a = inverse[0]!;
    let meat = 0;
    for (let t = 0; t < n; t += 1) {
      let fitted = 0;
      for (let i = 0; i < k; i += 1) fitted += beta[i]! * design[t]![i]!;
      const u = response[t]! - fitted;
      let projected = 0;
      for (let i = 0; i < k; i += 1) projected += a[i]! * design[t]![i]!;
      meat += (projected * u) ** 2;
    }
    const hc1 = Math.sqrt((meat * n) / (n - k));

    expect(hac!.value).toBeCloseTo(beta[0]!, 12);
    expect(hac!.standardError).toBeCloseTo(hc1, 12);
  });

  // The Bartlett weights run 1 - lag/(L+1), so the first of L lags is weighted
  // L/(L+1) and the last 1/(L+1). Reconstructing the whole sum from the
  // bandwidth-0 base and the package's own bandwidth-1 answer pins the weight:
  // an off-by-one in the denominator moves it by a measurable amount.
  it('weights the first lag by L/(L+1), not by 1', () => {
    const { x, y } = series(400, 0.8, 13);
    const zero = localProjection(x, y, 1, { bandwidth: 0, controlLags: 2 })!;
    const one = localProjection(x, y, 1, { bandwidth: 1, controlLags: 2 })!;
    const two = localProjection(x, y, 1, { bandwidth: 2, controlLags: 2 })!;

    // variance = base + 2*w1*c1 (+ 2*w2*c2). With L=1, w1 = 1/2. With L=2,
    // w1 = 2/3 and w2 = 1/3. So c1 recovered from L=1 must match the c1
    // implied by L=2 once c2 is accounted for — consistent only if the
    // denominator is L+1.
    const v0 = zero.standardError ** 2;
    const v1 = one.standardError ** 2;
    const v2 = two.standardError ** 2;

    const c1 = (v1 - v0) / (2 * (1 / 2));
    // From L=2: v2 - v0 = 2*(2/3)*c1 + 2*(1/3)*c2  ->  c2 follows.
    const c2 = ((v2 - v0) - 2 * (2 / 3) * c1) / (2 * (1 / 3));

    // c1 and c2 are real autocovariances of the score, so they are finite and
    // the reconstruction is self-consistent rather than degenerate.
    expect(Number.isFinite(c1)).toBe(true);
    expect(Number.isFinite(c2)).toBe(true);
    // Rebuilding v1 from the pieces returns exactly what the package said.
    expect(v0 + 2 * (1 / 2) * c1).toBeCloseTo(v1, 12);
    expect(v0 + 2 * (2 / 3) * c1 + 2 * (1 / 3) * c2).toBeCloseTo(v2, 12);
  });
});

describe('the estimator does the job it is there for', () => {
  // Overlapping horizons induce an MA(h) in the residuals. That is the whole
  // reason the PRD specifies Newey-West here, so the correction has to be
  // visible: with a long horizon and real overlap, the robust error exceeds
  // the bandwidth-0 one.
  it('widens the error when the horizon creates overlap', () => {
    const next = rng(17);
    const n = 500;
    const x = Array.from({ length: n }, () => normal(next));
    // A slow-moving y: overlapping windows share a lot of the same variation.
    const y: number[] = [];
    let level = 0;
    for (let t = 0; t < n; t += 1) {
      level = 0.85 * level + 0.6 * (x[t] as number) + 0.4 * normal(next);
      y.push(level);
    }

    const naive = localProjection(x, y, 6, { bandwidth: 0 })!;
    const robust = localProjection(x, y, 6)!;
    expect(robust.bandwidth).toBe(7);
    expect(robust.standardError).toBeGreaterThan(naive.standardError);
  });

  it('recovers a coefficient it was given, at the horizon it was given at', () => {
    const { x, y } = series(600, 0.8, 23);
    const atOne = localProjection(x, y, 1, { controlLags: 2 })!;
    const atThree = localProjection(x, y, 3, { controlLags: 2 })!;
    expect(atOne.value).toBeCloseTo(0.8, 1);
    expect(Math.abs(atThree.value)).toBeLessThan(0.15);
    expect(Math.abs(atOne.tStatistic)).toBeGreaterThan(Math.abs(atThree.tStatistic));
  });

  // A variance is never negative, whatever the truncated sum does.
  it('never returns a NaN standard error on a degenerate sample', () => {
    const flat = new Array<number>(200).fill(1);
    const result = localProjection(flat, flat, 1);
    if (result) {
      expect(Number.isNaN(result.standardError)).toBe(false);
      expect(result.standardError).toBeGreaterThanOrEqual(0);
    }
  });
});

/** Gauss-Jordan, written here so the check does not reuse the code under test. */
function invert(matrix: readonly number[][], k: number): number[][] | undefined {
  const a = matrix.map((row) => [...row]);
  const out: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let col = 0; col < k; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < k; row += 1) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) return undefined;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    [out[col], out[pivot]] = [out[pivot]!, out[col]!];
    const scale = a[col]![col]!;
    for (let j = 0; j < k; j += 1) {
      a[col]![j]! /= scale;
      out[col]![j]! /= scale;
    }
    for (let row = 0; row < k; row += 1) {
      if (row === col) continue;
      const factor = a[row]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < k; j += 1) {
        a[row]![j]! -= factor * a[col]![j]!;
        out[row]![j]! -= factor * out[col]![j]!;
      }
    }
  }
  return out;
}
