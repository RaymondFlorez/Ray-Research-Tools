/**
 * Calibration (PRD 5.5, 5.7).
 *
 * "The platform tracks its own and the market's calibration on resolved
 * contracts, producing reliability diagrams and Brier decompositions. This
 * feeds directly into the hypothesis tracker."
 *
 * And the line the tracker exists for, from the walkthrough: "Maya's own
 * hypothesis tracker is cited: she has made this call three times, right once."
 *
 * That sentence also sets the hardest constraint in this file. *Three times,
 * right once* is a fact worth putting in front of an analyst. A Brier score
 * computed on three observations is not — it is a number with an error bar
 * wider than its range, and reporting it would dress a fact up as a
 * measurement. So the count is always shown and the score is withheld until
 * there is enough history to mean something.
 */

/** One resolved prediction: what was claimed, and what happened. */
export interface Scored {
  /** The probability the analyst stated at the time. */
  confidence: number;
  /** True when the claim was supported, false when contradicted. */
  outcome: boolean;
  /** For the record, so a diagram can name its points. */
  id?: string;
  resolvedAt?: string;
}

export interface ReliabilityBucket {
  from: number;
  to: number;
  count: number;
  /** Average stated probability inside the bucket. */
  meanConfidence: number;
  /** Fraction that actually came true. */
  observedRate: number;
}

export interface Calibration {
  count: number;
  /** Mean squared error of the probabilities. Lower is better; 0.25 is a coin. */
  brier: number;
  /**
   * Murphy's decomposition: `brier = reliability - resolution + uncertainty`.
   *
   * - **reliability** — how far stated probabilities sit from realised rates.
   *   Lower is better, and this is the part an analyst can fix by adjusting
   *   how confident they say they are.
   * - **resolution** — how far the realised rates sit from the base rate.
   *   *Higher* is better, and this is the part that measures whether the
   *   analyst knows anything at all. A perfectly calibrated forecaster who
   *   always says the base rate scores zero here.
   * - **uncertainty** — the base rate's own variance. Not a skill term; it is
   *   how hard the questions were.
   */
  reliability: number;
  resolution: number;
  uncertainty: number;
  /** The realised base rate across all scored predictions. */
  baseRate: number;
  buckets: ReliabilityBucket[];
  /**
   * How the analyst leans, in probability points.
   *
   * Positive means they claim more confidence than the outcomes justify, which
   * is the direction almost everyone errs in.
   */
  overconfidence: number;
  /** Present when there is not enough history for the numbers to mean anything. */
  warning?: string;
}

/**
 * Below this the score is withheld, and only the tally is reported.
 *
 * Ten is not a statistical threshold so much as a floor of decency: at three
 * resolved claims the Brier score moves by 0.08 on a single outcome, so it
 * measures the last coin flip rather than the analyst.
 */
export const MIN_SCORED = 10;

const DEFAULT_EDGES = [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1.0001];

/**
 * Scores a track record.
 *
 * Only resolved predictions belong here. An expired claim has no outcome, and
 * scoring it as a failure would punish an analyst for data that never arrived —
 * `resolvedScores` is the filter that keeps them out.
 */
export function calibrate(scored: readonly Scored[], edges: readonly number[] = DEFAULT_EDGES): Calibration {
  const count = scored.length;
  if (count === 0) {
    return {
      count: 0,
      brier: Number.NaN,
      reliability: Number.NaN,
      resolution: Number.NaN,
      uncertainty: Number.NaN,
      baseRate: Number.NaN,
      buckets: [],
      overconfidence: Number.NaN,
      warning: 'no resolved predictions yet — nothing to calibrate against',
    };
  }

  let brier = 0;
  let outcomes = 0;
  let confidenceSum = 0;
  for (const s of scored) {
    const actual = s.outcome ? 1 : 0;
    brier += (s.confidence - actual) ** 2;
    outcomes += actual;
    confidenceSum += s.confidence;
  }
  brier /= count;
  const baseRate = outcomes / count;
  const uncertainty = baseRate * (1 - baseRate);

  const buckets: ReliabilityBucket[] = [];
  let reliability = 0;
  let resolution = 0;
  for (let i = 0; i < edges.length - 1; i += 1) {
    const from = edges[i] as number;
    const to = edges[i + 1] as number;
    const inBucket = scored.filter((s) => s.confidence >= from && s.confidence < to);
    if (inBucket.length === 0) continue;

    const meanConfidence = inBucket.reduce((sum, s) => sum + s.confidence, 0) / inBucket.length;
    const observedRate = inBucket.filter((s) => s.outcome).length / inBucket.length;
    buckets.push({
      from,
      to: Math.min(to, 1),
      count: inBucket.length,
      meanConfidence,
      observedRate,
    });

    // Murphy: the weighted squared gap between what was claimed and what
    // happened, against the weighted squared gap between what happened in each
    // bucket and what happens on average.
    reliability += (inBucket.length / count) * (meanConfidence - observedRate) ** 2;
    resolution += (inBucket.length / count) * (observedRate - baseRate) ** 2;
  }

  const overconfidence = confidenceSum / count - baseRate;
  const warning =
    count < MIN_SCORED
      ? `only ${count} resolved ${count === 1 ? 'prediction' : 'predictions'} — ` +
        `${outcomes} right. A track record, not yet a calibration.`
      : undefined;

  return {
    count,
    brier,
    reliability,
    resolution,
    uncertainty,
    baseRate,
    buckets,
    overconfidence,
    ...(warning !== undefined ? { warning } : {}),
  };
}

/**
 * The sentence the Critic cites: "she has made this call three times, right once."
 *
 * PRD 7.4 puts that line in a dissent block, and 7.4's next line says it is why
 * the tracker exists. Which means it has to be sayable in one string, from a
 * filtered history, with no score attached.
 */
export function trackRecord(scored: readonly Scored[], subject = 'this call'): string {
  if (scored.length === 0) return `no resolved record on ${subject}`;
  const right = scored.filter((s) => s.outcome).length;
  const times = scored.length === 1 ? 'once' : `${scored.length} times`;
  const hits = right === 0 ? 'never right' : right === 1 ? 'right once' : `right ${right} times`;
  return `made ${subject} ${times}, ${hits}`;
}
