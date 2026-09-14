/**
 * Look-ahead detectors (PRD 5.8).
 *
 * "Look-ahead detectors run automatically: signal-return correlation at
 * negative lags, and a shuffle test that permutes signal dates and checks that
 * performance collapses. A backtest that passes the shuffle test gets flagged
 * loudly, because it means something is leaking."
 *
 * That last clause inverts the usual reading and is the whole idea. "Passing"
 * the shuffle test means the strategy still performs after its signals have
 * been scrambled — which cannot happen if the signals were doing the work. A
 * strategy that survives having its own dates shuffled is not a strategy; it is
 * a leak, and the louder failure is the one that looks like success.
 *
 * The detectors run on every backtest rather than on request. A check the
 * analyst has to remember is a check that runs on the results they already
 * doubt.
 */

import { backtest, type BacktestOptions, type BacktestResult, type Strategy } from './engine.js';
import type { History } from './pointInTime.js';
import { sharpe } from './statistics.js';

/** Deterministic permutation, so a flagged backtest can be re-run and re-flagged. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = () => {
    // xorshift32: small, deterministic, and good enough to scramble dates.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

export interface ShuffleTest {
  /** The real backtest's annualized Sharpe. */
  actual: number;
  /** Median Sharpe across the permuted runs. */
  shuffledMedian: number;
  /** The permuted Sharpes, sorted. */
  shuffled: number[];
  /**
   * Fraction of permutations that matched or beat the real run.
   *
   * A sound strategy leaves this near zero: scrambling its signals should
   * destroy it. Anything above `SHUFFLE_ALARM` means the performance did not
   * depend on the signals being in the right order.
   */
  survivalRate: number;
  /** True when the strategy survived having its signals scrambled. */
  leaking: boolean;
  /**
   * True when there was no performance for the shuffle to destroy.
   *
   * The test compares a real run against scrambled ones, so it can separate a
   * genuine edge from a leak — and cannot separate a leak from a strategy that
   * never worked. A Sharpe near zero survives shuffling trivially, and calling
   * that "leaking" would be a detector firing on the absence of a result.
   */
  inconclusive: boolean;
  verdict: string;
}

/**
 * Above this share of permutations beating the real run, something is leaking.
 *
 * Ten percent, not five. This is a screen an analyst should act on rather than
 * a hypothesis test to publish, and the cost of investigating a clean backtest
 * is an hour while the cost of trading a leaky one is the fund.
 */
export const SHUFFLE_ALARM = 0.1;

/**
 * Below this annualized Sharpe there is nothing to explain.
 *
 * The shuffle test asks "did scrambling the dates destroy the performance?",
 * which is only a question when there was performance. A strategy at 0.2 Sharpe
 * survives its own shuffle because there was never anything to lose, and
 * reporting that as a leak would train analysts to ignore the detector on
 * exactly the runs where it matters.
 */
export const MINIMUM_PERFORMANCE = 0.5;

/**
 * Runs the backtest again with the signal dates permuted.
 *
 * The strategy sees the same *set* of signal values, in the wrong order. A
 * strategy whose edge is real loses it; one that is reading returns out of its
 * own input keeps it, because the leak travels with the values rather than with
 * their dates.
 */
export function shuffleTest(
  history: History,
  strategy: Strategy,
  options: BacktestOptions,
  permutations = 20,
): ShuffleTest {
  const actual = sharpe(backtest(history, strategy, options).returns, options.periodsPerYear ?? 252);

  const dates = history.dates();
  const results: number[] = [];
  for (let trial = 0; trial < permutations; trial += 1) {
    const order = shuffled(dates, 0x5eed + trial);
    // The permutation maps each real bar to a different bar's view, so the
    // strategy is fed the right values on the wrong days.
    const scrambled: Strategy = (_view, state) => {
      const at = dates.indexOf(state.date);
      const substitute = order[at] ?? state.date;
      // The supplied view is discarded on purpose: the strategy is handed the
      // view from a *different* bar, which is what scrambling the signal dates
      // means. Its own state — cash, positions, the real date — is untouched.
      return strategy(history.viewAt(substitute), state);
    };
    results.push(
      sharpe(backtest(history, scrambled, options).returns, options.periodsPerYear ?? 252),
    );
  }

  results.sort((a, b) => a - b);
  const median = results[Math.floor(results.length / 2)] ?? 0;
  const survivalRate = results.filter((s) => s >= actual - 1e-12).length / results.length;
  const inconclusive = actual < MINIMUM_PERFORMANCE;
  const leaking = !inconclusive && survivalRate > SHUFFLE_ALARM;

  let verdict: string;
  if (inconclusive) {
    verdict =
      `inconclusive: the real run scored ${actual.toFixed(2)}, which is nothing for a shuffle ` +
      `to destroy. The test can tell an edge from a leak; it cannot tell a leak from a ` +
      `strategy that never worked.`;
  } else if (leaking) {
    verdict =
      `LEAKING: ${Math.round(survivalRate * 100)}% of shuffled runs matched or beat the real one ` +
      `(real ${actual.toFixed(2)}, shuffled median ${median.toFixed(2)}). ` +
      `Scrambling the signal dates did not destroy the performance, so the performance was ` +
      `not coming from the signals.`;
  } else {
    verdict =
      `clean: shuffling the signal dates collapsed the Sharpe from ${actual.toFixed(2)} to ` +
      `${median.toFixed(2)}, which is what a real edge does`;
  }

  return { actual, shuffledMedian: median, shuffled: results, survivalRate, leaking, inconclusive, verdict };
}

export interface NegativeLagTest {
  /** Correlation of the signal with returns at each lag; negative lags first. */
  correlations: Array<{ lag: number; correlation: number }>;
  /** The strongest correlation at a negative lag. */
  worstNegative: { lag: number; correlation: number } | undefined;
  leaking: boolean;
  verdict: string;
}

/** A signal correlated with returns that already happened is reading the future. */
export const NEGATIVE_LAG_ALARM = 0.2;

/**
 * Correlates the signal against returns at negative lags.
 *
 * At lag −1 the question is whether today's signal knows yesterday's return.
 * A momentum signal legitimately does, so this is not on its own proof of a
 * leak — but a signal built from *contemporaneous or future* information shows
 * a correlation at negative lags far stronger than its correlation at positive
 * ones, and that asymmetry is what the verdict reports.
 */
export function negativeLagTest(
  signal: readonly number[],
  returns: readonly number[],
  maxLag = 5,
): NegativeLagTest {
  const correlations: Array<{ lag: number; correlation: number }> = [];
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    correlations.push({ lag, correlation: correlate(signal, returns, lag) });
  }

  // Lag zero belongs on the backward side. A signal perfectly correlated with
  // *today's* return is the purest leak there is, and the first version of this
  // looked only at lag -1 and earlier, so it missed it entirely.
  const negatives = correlations.filter((c) => c.lag <= 0);
  const positives = correlations.filter((c) => c.lag > 0);
  const worstNegative = negatives.reduce<{ lag: number; correlation: number } | undefined>(
    (worst, c) => (!worst || Math.abs(c.correlation) > Math.abs(worst.correlation) ? c : worst),
    undefined,
  );
  const bestPositive = positives.reduce((best, c) => Math.max(best, Math.abs(c.correlation)), 0);

  // A leak looks like a signal that explains the past better than the future.
  const leaking =
    worstNegative !== undefined &&
    Math.abs(worstNegative.correlation) > NEGATIVE_LAG_ALARM &&
    Math.abs(worstNegative.correlation) > bestPositive;

  return {
    correlations,
    worstNegative,
    leaking,
    verdict: leaking
      ? `LEAKING: the signal correlates ${worstNegative?.correlation.toFixed(2)} with returns at ` +
        `lag ${worstNegative?.lag}, stronger than anything it manages going forward ` +
        `(${bestPositive.toFixed(2)}). It knows more about the past than the future.`
      : `clean: no negative-lag correlation above ${NEGATIVE_LAG_ALARM}`,
  };
}

/** Pearson correlation of `signal[t]` against `returns[t + lag]`. */
function correlate(signal: readonly number[], returns: readonly number[], lag: number): number {
  const pairs: Array<[number, number]> = [];
  for (let t = 0; t < signal.length; t += 1) {
    const at = t + lag;
    if (at < 0 || at >= returns.length) continue;
    pairs.push([signal[t] as number, returns[at] as number]);
  }
  if (pairs.length < 3) return 0;

  let sx = 0;
  let sy = 0;
  for (const [x, y] of pairs) {
    sx += x;
    sy += y;
  }
  const mx = sx / pairs.length;
  const my = sy / pairs.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}

export interface Audit {
  shuffle: ShuffleTest;
  deflated: BacktestResult['deflated'];
  /** Every reason to distrust this backtest, in one place. */
  findings: string[];
  trustworthy: boolean;
}

/**
 * Every automatic check, run together.
 *
 * Returned with the result rather than offered alongside it, because PRD 5.8
 * says these "run automatically" — and a detector the analyst has to ask for is
 * one they will ask for only when they already suspect the answer.
 */
export function audit(
  history: History,
  strategy: Strategy,
  options: BacktestOptions,
  permutations = 20,
): Audit {
  const result = backtest(history, strategy, options);
  const shuffle = shuffleTest(history, strategy, options, permutations);

  const findings: string[] = [];
  if (shuffle.leaking || shuffle.inconclusive) findings.push(shuffle.verdict);
  if (result.deflated.notSignificant) {
    findings.push(
      `the deflated Sharpe puts this at ${(result.deflated.probability * 100).toFixed(0)}% ` +
        `against ${result.deflated.trials} trials — the best of that many random strategies ` +
        `would be expected to show ${result.deflated.expectedMaximum.toFixed(2)}`,
    );
  }
  if (result.trades.length < 30) {
    findings.push(`only ${result.trades.length} trades — too few to distinguish edge from luck`);
  }

  return { shuffle, deflated: result.deflated, findings, trustworthy: findings.length === 0 };
}
