/**
 * The regime split (PRD 5.6, Appendix C.3).
 *
 * "The regime split is not optional and cannot be hidden, because a single
 * elasticity averaged across a structural break is usually the most confidently
 * wrong number on the canvas."
 *
 * That sentence is the whole module. An elasticity estimated across a break is
 * not merely imprecise — it is *precise about a number that was never true*,
 * because averaging two stable regimes produces a tight standard error around a
 * value neither regime ever took. The wide error bar that would warn you never
 * appears.
 *
 * So every edge is estimated three times: once on the whole window, and once on
 * each side of the split. Where the halves disagree by more than their own
 * uncertainty, the full-sample number is the one to distrust.
 */

import { localProjection, type Coefficient, type LocalProjectionOptions } from './estimate.js';

export interface RegimeSplit {
  /** Index at which the sample divides. */
  at: number;
  /** Set when the split was found in the data rather than supplied. */
  detected: boolean;
  /**
   * How much better two regressions fit than one, as an F-like ratio.
   *
   * Only meaningful for a detected split; a supplied one reports it too, so a
   * date the analyst chose can be checked against the data.
   */
  improvement: number;
}

export interface RegimeEstimate {
  /** The estimate an analyst would get if nobody mentioned regimes. */
  full: Coefficient;
  before: Coefficient | undefined;
  after: Coefficient | undefined;
  split: RegimeSplit;
  /**
   * True when the two halves disagree by more than their combined uncertainty.
   *
   * The test is on the difference of the two coefficients against the standard
   * error of that difference — which is the question actually being asked
   * ("are these the same number?") rather than the more common and weaker
   * "do their intervals overlap?".
   */
  unstable: boolean;
  /** What the node says. Empty when the full-sample number is safe to use. */
  warning?: string;
}

/**
 * Two standard errors of the difference — correct **only** for a break the
 * analyst named in advance.
 *
 * For a break the detector searched for, this threshold is badly wrong, and
 * wrong in the direction that cries wolf. `test/calibration.test.ts` measures
 * it: with no break present at all, the largest gap found over ~350 candidate
 * split points clears two standard errors more than half the time, and reaches
 * 3.5. Applying a single-comparison threshold to the maximum of a search is the
 * multiple-comparisons error, and a detector that flags stable data teaches
 * analysts to ignore it.
 */
export const INSTABILITY_T = 2;

/**
 * The threshold for a break the detector *found*, on the fit-improvement
 * statistic rather than on the coefficient gap.
 *
 * Measured rather than assumed: under the null the searched improvement has a
 * 95th percentile of 5.8 and a maximum of 6.5 over forty trials, while a
 * genuine regime change scores above 50. Twelve sits in the gap with room on
 * both sides, and is the same order as the Andrews sup-Wald critical values
 * that exist for exactly this problem — a statistic maximised over an unknown
 * breakpoint needs a higher bar than one tested at a known one.
 */
export const SEARCHED_BREAK_F = 12;

/** The smallest usable segment, so a "break" cannot be three observations. */
export const MIN_SEGMENT = 24;

/**
 * Finds the split that best explains the relationship, if one does.
 *
 * A sweep over candidate breakpoints, scoring each by the summed squared error
 * of two separate simple regressions against one — the Quandt-style approach,
 * kept deliberately simple because the output is a *suggestion* an analyst can
 * override, not a published test statistic.
 */
export function detectSplit(x: readonly number[], y: readonly number[]): RegimeSplit {
  const n = Math.min(x.length, y.length);
  const whole = sumSquares(x, y, 0, n);
  let best = { at: Math.floor(n / 2), improvement: 0 };

  for (let at = MIN_SEGMENT; at <= n - MIN_SEGMENT; at += 1) {
    const split = sumSquares(x, y, 0, at) + sumSquares(x, y, at, n);
    if (split <= 0) continue;
    // The ratio of variance explained by allowing a break, scaled by the
    // degrees of freedom it costs.
    const improvement = ((whole - split) / 2) / (split / Math.max(1, n - 4));
    if (improvement > best.improvement) best = { at, improvement };
  }

  return { at: best.at, detected: best.improvement > 0, improvement: best.improvement };
}

/** Residual sum of squares of a simple regression over `[from, to)`. */
function sumSquares(x: readonly number[], y: readonly number[], from: number, to: number): number {
  const n = to - from;
  if (n < 3) return Number.POSITIVE_INFINITY;
  let sx = 0;
  let sy = 0;
  for (let t = from; t < to; t += 1) {
    sx += x[t] as number;
    sy += y[t] as number;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let t = from; t < to; t += 1) {
    const dx = (x[t] as number) - mx;
    const dy = (y[t] as number) - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return syy;
  return Math.max(0, syy - (sxy * sxy) / sxx);
}

/**
 * Estimates an elasticity on the full window and on each regime.
 *
 * `splitAt` supplies a break the analyst knows about — a policy change, a
 * merger, 2020. Without it the split is detected, and the answer says which it
 * was, because a break someone asserted and a break the data suggested deserve
 * different amounts of trust.
 */
export function estimateWithRegimes(
  x: readonly number[],
  y: readonly number[],
  horizon: number,
  options: LocalProjectionOptions & { splitAt?: number } = {},
): RegimeEstimate | undefined {
  const full = localProjection(x, y, horizon, options);
  if (!full) return undefined;

  const n = Math.min(x.length, y.length);
  const split: RegimeSplit =
    options.splitAt !== undefined
      ? { at: options.splitAt, detected: false, improvement: detectSplit(x, y).improvement }
      : detectSplit(x, y);

  const usable = split.at >= MIN_SEGMENT && split.at <= n - MIN_SEGMENT;
  const before = usable
    ? localProjection(x.slice(0, split.at), y.slice(0, split.at), horizon, options)
    : undefined;
  const after = usable
    ? localProjection(x.slice(split.at), y.slice(split.at), horizon, options)
    : undefined;

  let unstable = false;
  let warning: string | undefined;
  if (before && after) {
    const gap = after.value - before.value;
    const error = Math.hypot(before.standardError, after.standardError);
    // Which test applies depends on where the break came from. A date the
    // analyst named is one hypothesis, and two standard errors is the right
    // bar. A date the detector picked is the best of hundreds, and has to clear
    // the bar that a search implies.
    unstable = split.detected
      ? split.improvement > SEARCHED_BREAK_F
      : error > 0 && Math.abs(gap) / error > INSTABILITY_T;
    if (unstable) {
      warning =
        `unstable across the sample: ${before.value.toFixed(2)} before the break, ` +
        `${after.value.toFixed(2)} after (full sample says ${full.value.toFixed(2)}). ` +
        `The single number is an average of two regimes, not an estimate of either.`;
    }
  }

  return { full, before, after, split, unstable, ...(warning !== undefined ? { warning } : {}) };
}
