/**
 * The deflated Sharpe ratio, checked against the published formula.
 *
 * Bailey and López de Prado (2014) give it in closed form:
 *
 *   DSR = Z[ (SR - SR*) sqrt(n-1) / sqrt(1 - g3 SR + ((g4-1)/4) SR^2) ]
 *   SR* = sqrt(V[SR]) [ (1-y) Z^-1(1 - 1/N) + y Z^-1(1 - 1/(Ne)) ]
 *
 * with SR per-period, g3 skewness, g4 *non-excess* kurtosis, y the
 * Euler-Mascheroni constant and N the trial count. An earlier version of this
 * module dropped the sqrt(V[SR]) scaling on SR*, which deflated by an
 * annualized 46 and was caught by a test asserting a plausible range. That is
 * exactly the kind of error a plausible-range test catches only by luck, so
 * the formula is reconstructed here from the paper rather than from the
 * implementation.
 */

import { describe, expect, it } from 'vitest';
import { deflatedSharpe, moments, sharpe } from '../src/statistics.js';

const EULER = 0.577_215_664_901_532_9;

/** Acklam's inverse normal CDF, written here so the check is independent. */
function inverseNormal(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - low) return -inverseNormal(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

function standardNormalCdf(z: number): number {
  // Abramowitz-Stegun 26.2.17, independent of the package's own erf.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** The paper's formula, from the paper. */
function published(returns: readonly number[], trials: number) {
  const m = moments(returns);
  const sr = m.mean / m.stdev;
  const g3 = m.skew;
  const g4 = m.kurtosis + 3; // the paper uses non-excess kurtosis
  const varianceOfSharpe = (1 - g3 * sr + ((g4 - 1) / 4) * sr * sr) / (m.count - 1);
  const sd = Math.sqrt(varianceOfSharpe);
  const srStar =
    trials <= 1
      ? 0
      : sd * ((1 - EULER) * inverseNormal(1 - 1 / trials) + EULER * inverseNormal(1 - 1 / (trials * Math.E)));
  return { dsr: standardNormalCdf((sr - srStar) / sd), srStar, sd, sr };
}

/** Returns with a stated mean, dispersion, and a deliberate skew. */
function draws(n: number, mean: number, sd: number, skewSize: number, seed: number): number[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4_294_967_296;
  };
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const u = Math.max(next(), 1e-12);
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    // A cubic term bends the distribution without moving it much.
    out.push(mean + sd * (z + skewSize * (z * z - 1)));
  }
  return out;
}

describe('the deflated Sharpe matches the published closed form', () => {
  it.each([
    ['one trial', 1],
    ['ten trials', 10],
    ['a thousand trials', 1_000],
    ['ten thousand trials', 10_000],
  ])('at %s', (_label, trials) => {
    const returns = draws(500, 0.0008, 0.011, -0.25, 7);
    const mine = deflatedSharpe(returns, trials);
    const theirs = published(returns, trials);

    expect(mine.probability).toBeCloseTo(theirs.dsr, 6);
    // The expected maximum is reported annualized.
    expect(mine.expectedMaximum).toBeCloseTo(theirs.srStar * Math.sqrt(252), 8);
  });

  // With a single trial there is nothing to deflate, and the DSR collapses to
  // the probabilistic Sharpe ratio.
  it('collapses to the probabilistic Sharpe at one trial', () => {
    const returns = draws(400, 0.0006, 0.01, 0, 11);
    const result = deflatedSharpe(returns, 1);
    const { sr, sd } = published(returns, 1);
    expect(result.expectedMaximum).toBe(0);
    expect(result.probability).toBeCloseTo(standardNormalCdf(sr / sd), 6);
  });

  it('reports the observed Sharpe annualized, unchanged by the deflation', () => {
    const returns = draws(400, 0.0006, 0.01, 0, 13);
    expect(deflatedSharpe(returns, 500).observed).toBeCloseTo(sharpe(returns, 252), 12);
  });
});

describe('the two corrections both bite', () => {
  // Negative skew and fat tails widen the Sharpe estimator's variance, which
  // is the first correction in the paper.
  it('penalises negative skew', () => {
    const symmetric = draws(500, 0.0008, 0.011, 0, 17);
    const skewed = draws(500, 0.0008, 0.011, -0.6, 17);
    const a = deflatedSharpe(symmetric, 100);
    const b = deflatedSharpe(skewed, 100);
    expect(moments(skewed).skew).toBeLessThan(moments(symmetric).skew);
    expect(b.probability).toBeLessThan(a.probability);
  });

  // The second correction: more trials, higher bar.
  it('raises the bar as the trial count grows', () => {
    const returns = draws(500, 0.0008, 0.011, 0, 19);
    const few = deflatedSharpe(returns, 5);
    const many = deflatedSharpe(returns, 5_000);
    expect(many.expectedMaximum).toBeGreaterThan(few.expectedMaximum);
    expect(many.probability).toBeLessThan(few.probability);
  });

  // A per-period Sharpe of about 0.15 over 400 observations clears the bar
  // comfortably on its own: three standard errors from zero, annualising to
  // roughly 2.4. The point is that the same record fails once you admit how
  // many strategies were tried to find it.
  it('can turn a significant backtest insignificant on trial count alone', () => {
    const returns = draws(400, 0.0018, 0.012, 0, 23);
    const alone = deflatedSharpe(returns, 1);
    expect(alone.probability).toBeGreaterThan(0.95);
    expect(alone.notSignificant).toBe(false);

    const searched = deflatedSharpe(returns, 100_000);
    expect(searched.notSignificant).toBe(true);
    // The observed Sharpe never moved; only the bar did.
    expect(searched.observed).toBeCloseTo(alone.observed, 12);
  });
});

describe('what the implementation substitutes', () => {
  /**
   * The paper's `V[SR]` in the `SR*` term is the variance of the Sharpe ratios
   * *across trials*. Without those trial Sharpes in hand, this module uses the
   * estimator variance of the single observed Sharpe as a stand-in, which is
   * the usual practical substitution and is not the same quantity: a set of
   * genuinely different strategies disperses more than one strategy's sampling
   * error does, so the bar this raises is, if anything, too low.
   *
   * Recorded as a test rather than only as a comment, because it is the one
   * place the implementation departs from the paper.
   */
  it('uses the estimator standard error as the cross-trial dispersion', () => {
    const returns = draws(500, 0.0008, 0.011, 0, 29);
    const { sd } = published(returns, 1_000);
    const result = deflatedSharpe(returns, 1_000);
    const bracket =
      (1 - EULER) * inverseNormal(1 - 1 / 1_000) + EULER * inverseNormal(1 - 1 / (1_000 * Math.E));
    expect(result.expectedMaximum / Math.sqrt(252)).toBeCloseTo(sd * bracket, 10);
  });
});
