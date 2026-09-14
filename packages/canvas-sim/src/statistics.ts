/**
 * Performance statistics, including the one that hurts (PRD 5.8).
 *
 * "Outputs: equity curve, per-trade log, exposure over time, factor
 * attribution, and a deflated Sharpe ratio adjusted for the number of trials
 * the analyst has run on this canvas. The trial counter is tracked
 * automatically, which is uncomfortable and correct."
 *
 * The deflated Sharpe ratio is the reason this file is not just a mean over a
 * standard deviation. Try enough strategies and one of them backtests
 * beautifully by luck; the ordinary Sharpe ratio cannot tell you that happened,
 * and the analyst who ran the trials is the last person who will volunteer it.
 */

export interface Moments {
  mean: number;
  /** Sample standard deviation, with the n−1 correction. */
  stdev: number;
  skew: number;
  /** Excess kurtosis: zero for a normal distribution. */
  kurtosis: number;
  count: number;
}

export function moments(values: readonly number[]): Moments {
  const n = values.length;
  if (n < 2) return { mean: n === 1 ? (values[0] as number) : 0, stdev: 0, skew: 0, kurtosis: 0, count: n };

  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;

  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of values) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  const variance = m2 / (n - 1);
  const stdev = Math.sqrt(variance);
  // Population moments for the shape statistics, which is what the deflated
  // Sharpe formula is written in.
  const population = Math.sqrt(m2 / n);
  return {
    mean,
    stdev,
    skew: population > 0 ? m3 / n / population ** 3 : 0,
    kurtosis: population > 0 ? m4 / n / population ** 4 - 3 : 0,
    count: n,
  };
}

/** Annualized Sharpe ratio from periodic returns. */
export function sharpe(returns: readonly number[], periodsPerYear = 252, riskFree = 0): number {
  const m = moments(returns.map((r) => r - riskFree / periodsPerYear));
  if (m.stdev === 0) return 0;
  return (m.mean / m.stdev) * Math.sqrt(periodsPerYear);
}

/** Standard normal CDF, by Abramowitz-Stegun 7.1.26 on erf. */
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

/**
 * Inverse standard normal, by Acklam's rational approximation.
 *
 * Named coefficients rather than indexed arrays: with `noUncheckedIndexedAccess`
 * every lookup would need a cast, and a Horner chain full of casts is a place
 * for a misplaced parenthesis to hide — which is exactly what happened when
 * this was written the other way.
 */
function normalQuantile(p: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY;
  if (p >= 1) return Number.POSITIVE_INFINITY;
  if (p > 0.97575) return -normalQuantile(1 - p);

  if (p < 0.02425) {
    // Lower tail: a series in sqrt(-2 ln p).
    const q = Math.sqrt(-2 * Math.log(p));
    const num =
      ((((-0.007784894002430293 * q - 0.3223964580411365) * q - 2.400758277161838) * q -
        2.549732539343734) *
        q +
        4.374664141464968) *
        q +
      2.938163982698783;
    const den =
      (((0.007784695709041462 * q + 0.3224671290700398) * q + 2.445134137142996) * q +
        3.754408661907416) *
        q +
      1;
    return num / den;
  }

  // Central region: a series in (p - 1/2)^2.
  const q = p - 0.5;
  const r = q * q;
  const num =
    (((((-39.69683028665376 * r + 220.9460984245205) * r - 275.9285104469687) * r +
      138.357751867269) *
      r -
      30.66479806614716) *
      r +
      2.506628277459239) *
    q;
  const den =
    ((((-54.4760987982241 * r + 161.5858368580409) * r - 155.6989798598866) * r +
      66.80131188771972) *
      r -
      13.28068155288572) *
      r +
    1;
  return num / den;
}

export interface DeflatedSharpe {
  observed: number;
  /**
   * The Sharpe ratio you would expect the *best* of `trials` random strategies
   * to show, given none of them has any edge.
   */
  expectedMaximum: number;
  /**
   * Probability the observed Sharpe exceeds what selection alone would produce.
   *
   * Below 0.95 the strategy has not cleared the bar its own search set.
   */
  probability: number;
  trials: number;
  /** True when the strategy fails to beat its own selection effect. */
  notSignificant: boolean;
}

/** Euler-Mascheroni, for the expected maximum of `trials` normal draws. */
const EULER = 0.5772156649015329;

/**
 * Bailey and López de Prado's deflated Sharpe ratio.
 *
 * Two corrections, and both matter. The **variance of the Sharpe estimator**
 * depends on the returns' skew and kurtosis — a strategy that makes small
 * gains and occasional large losses has a far less reliable Sharpe than its
 * point estimate suggests. And the **expected maximum over trials** is what
 * turns "I found a 2.0 Sharpe" into "I looked at four hundred strategies and
 * the best one showed 2.0", which are not the same claim.
 */
export function deflatedSharpe(
  returns: readonly number[],
  trials: number,
  periodsPerYear = 252,
): DeflatedSharpe {
  const m = moments(returns);
  const n = m.count;
  const observed = sharpe(returns, periodsPerYear);
  const perPeriod = m.stdev > 0 ? m.mean / m.stdev : 0;

  // Variance of the Sharpe estimator under non-normal returns. Negative skew
  // and fat tails both widen it, which is the first of the two corrections.
  const variance =
    (1 - m.skew * perPeriod + ((m.kurtosis + 3 - 1) / 4) * perPeriod * perPeriod) /
    Math.max(1, n - 1);
  const spread = Math.sqrt(Math.max(variance, 1e-18));

  // The expected maximum of `trials` independent draws, to second order.
  //
  // Scaled by `spread`, and that scaling is the whole formula. The bracket is
  // the expected maximum of N *standard normal* draws — about 3 at a thousand
  // trials — and reading it as a Sharpe ratio would deflate by an annualized 46,
  // which is what the first version of this did. What is actually distributed
  // that way is the Sharpe estimator's own error, so the dispersion of trial
  // Sharpes is what the bracket multiplies.
  const attempts = Math.max(1, trials);
  const expectedMaxPerPeriod =
    attempts <= 1
      ? 0
      : spread *
        ((1 - EULER) * normalQuantile(1 - 1 / attempts) +
          EULER * normalQuantile(1 - 1 / (attempts * Math.E)));

  const probability = normalCdf((perPeriod - expectedMaxPerPeriod) / spread);
  return {
    observed,
    expectedMaximum: expectedMaxPerPeriod * Math.sqrt(periodsPerYear),
    probability,
    trials: attempts,
    notSignificant: probability < 0.95,
  };
}

export interface Drawdown {
  /** Largest peak-to-trough fall, as a positive fraction. */
  maximum: number;
  /** Index where the trough occurred. */
  troughAt: number;
  /** Periods from the peak to the trough. */
  length: number;
}

export function maxDrawdown(equity: readonly number[]): Drawdown {
  let peak = equity[0] ?? 0;
  let peakAt = 0;
  let worst: Drawdown = { maximum: 0, troughAt: 0, length: 0 };
  for (let i = 0; i < equity.length; i += 1) {
    const value = equity[i] as number;
    if (value > peak) {
      peak = value;
      peakAt = i;
    }
    const fall = peak > 0 ? (peak - value) / peak : 0;
    if (fall > worst.maximum) worst = { maximum: fall, troughAt: i, length: i - peakAt };
  }
  return worst;
}

/** Conditional value at risk: the mean of the worst `alpha` tail. */
export function cvar(values: readonly number[], alpha = 0.05): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.max(1, Math.floor(sorted.length * alpha));
  let sum = 0;
  for (let i = 0; i < cut; i += 1) sum += sorted[i] as number;
  return sum / cut;
}

/** Linear-interpolated percentile of a sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] as number;
  return (sorted[lower] as number) + (position - lower) * ((sorted[upper] as number) - (sorted[lower] as number));
}
