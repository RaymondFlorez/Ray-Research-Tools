/**
 * The hypothesis tracker (PRD 3.5, 5.7).
 *
 * "A structured node where the analyst states a claim, attaches predicted
 * observables with thresholds and dates, and wires in the data that would
 * confirm or falsify it. Picasso then tracks the claim automatically: as data
 * arrives, the hypothesis node updates a status of `supported`,
 * `contradicted`, `undetermined`, or `expired`, and logs the analyst's
 * calibration history over time. This is the feature that turns the canvas into
 * an accountability instrument rather than a mood board."
 *
 * The PRD's worked example carries the design in it: "Observable: reported
 * segment GM. Threshold: 71 percent. Date: the next report. Falsifier: GM above
 * 73 percent."
 *
 * **The threshold and the falsifier are different numbers, and the gap between
 * them is the point.** A claim with one cutoff is a coin flip that always
 * resolves; a claim with two has a region where the analyst was neither right
 * nor wrong, and saying so is the difference between a track record and a
 * scoreboard. Gross margin at 72 percent does not confirm "below 71" and does
 * not refute it either.
 *
 * "The node will resolve itself when the data arrives, whether or not she
 * remembers it" — so resolution is a pure function of the claim, the
 * observations and the clock. Nothing here asks to be told what happened.
 */

/** PRD 3.5's four states. */
export type HypothesisStatus = 'undetermined' | 'supported' | 'contradicted' | 'expired';

/** A measurable prediction, with the two cutoffs that make it falsifiable. */
export interface Observable {
  id: string;
  name: string;
  /** Which side of the threshold supports the claim. */
  direction: 'below' | 'above';
  /** Reaching this side of the threshold supports the claim. */
  threshold: number;
  /**
   * Passing this supports the opposite. Must lie on the far side of the
   * threshold, leaving the region between them inconclusive.
   */
  falsifier: number;
  /** After this, an unobserved prediction has expired rather than failed. */
  dueBy: string;
  unit?: string;
}

export interface Hypothesis {
  id: string;
  claim: string;
  /**
   * The analyst's stated probability that the claim holds.
   *
   * Required, not optional: an unscored prediction cannot be calibrated, and a
   * tracker that lets you skip the number is one you will skip the number on.
   */
  confidence: number;
  observables: Observable[];
  createdAt: string;
  author?: string;
}

export interface Observation {
  observableId: string;
  value: number;
  observedAt: string;
  /** Where the number came from, for the audit trail. */
  source?: string;
}

export interface ObservableOutcome {
  observable: Observable;
  status: HypothesisStatus;
  value?: number;
  /** Plain-language account of why it landed where it did. */
  reason: string;
}

export interface Resolution {
  status: HypothesisStatus;
  outcomes: ObservableOutcome[];
  /** When the claim reached a terminal state, if it has. */
  resolvedAt?: string;
  explanation: string;
  /**
   * `true` when supported, `false` when contradicted, and absent otherwise.
   *
   * Absent is not a third value to score. An expired claim and an inconclusive
   * one have no outcome, and feeding either into a Brier score as a zero would
   * punish an analyst for the world not producing data.
   */
  outcome?: boolean;
}

/** Rejects a claim that cannot be wrong. */
export function validate(hypothesis: Hypothesis): string[] {
  const problems: string[] = [];
  if (!(hypothesis.confidence >= 0 && hypothesis.confidence <= 1)) {
    problems.push('confidence must be a probability between 0 and 1');
  }
  if (hypothesis.observables.length === 0) {
    problems.push('a claim with no observable cannot be checked, only believed');
  }
  for (const observable of hypothesis.observables) {
    const falsifierIsFarSide =
      observable.direction === 'below'
        ? observable.falsifier > observable.threshold
        : observable.falsifier < observable.threshold;
    if (!falsifierIsFarSide) {
      problems.push(
        `${observable.name}: the falsifier must sit on the far side of the threshold — ` +
          'otherwise every observation both confirms and refutes the claim',
      );
    }
  }
  return problems;
}

/** Where one observation lands against one prediction. */
function judge(observable: Observable, value: number): { status: HypothesisStatus; reason: string } {
  const unit = observable.unit ?? '';
  const supported =
    observable.direction === 'below' ? value <= observable.threshold : value >= observable.threshold;
  if (supported) {
    return {
      status: 'supported',
      reason: `${value}${unit} is ${observable.direction} the ${observable.threshold}${unit} threshold`,
    };
  }
  const refuted =
    observable.direction === 'below' ? value >= observable.falsifier : value <= observable.falsifier;
  if (refuted) {
    return {
      status: 'contradicted',
      reason: `${value}${unit} passed the ${observable.falsifier}${unit} falsifier`,
    };
  }
  return {
    status: 'undetermined',
    reason:
      `${value}${unit} fell between the ${observable.threshold}${unit} threshold and the ` +
      `${observable.falsifier}${unit} falsifier — the claim is neither confirmed nor refuted`,
  };
}

/**
 * Resolves a claim against whatever data has arrived.
 *
 * Precedence, in order:
 *
 *  1. **Any falsifier that fired wins.** That is what a falsifier is for, and a
 *     claim that survives by averaging one refutation against two confirmations
 *     is not being tested.
 *  2. Every observable supported means the claim is supported.
 *  3. Anything still awaited leaves the claim open — `undetermined`, not failed.
 *  4. Otherwise, whether the data never came (`expired`) or came and said
 *     nothing (`undetermined`).
 */
export function resolve(
  hypothesis: Hypothesis,
  observations: readonly Observation[],
  now: string,
): Resolution {
  const byObservable = new Map<string, Observation>();
  for (const observation of observations) {
    const existing = byObservable.get(observation.observableId);
    // The first observation is the one that counts: a prediction resolved by
    // the data available on the due date cannot be un-resolved by a later
    // revision, or the track record becomes editable after the fact.
    if (!existing || observation.observedAt < existing.observedAt) {
      byObservable.set(observation.observableId, observation);
    }
  }

  const outcomes: ObservableOutcome[] = hypothesis.observables.map((observable) => {
    const observation = byObservable.get(observable.id);
    if (!observation) {
      return now > observable.dueBy
        ? {
            observable,
            status: 'expired' as const,
            reason: `nothing was observed by ${observable.dueBy}`,
          }
        : {
            observable,
            status: 'undetermined' as const,
            reason: `awaiting the observation, due ${observable.dueBy}`,
          };
    }
    const verdict = judge(observable, observation.value);
    return { observable, status: verdict.status, value: observation.value, reason: verdict.reason };
  });

  const has = (status: HypothesisStatus) => outcomes.some((o) => o.status === status);
  const pending = outcomes.some(
    (o) => o.status === 'undetermined' && o.value === undefined && now <= o.observable.dueBy,
  );

  let status: HypothesisStatus;
  if (has('contradicted')) {
    status = 'contradicted';
  } else if (outcomes.every((o) => o.status === 'supported')) {
    status = 'supported';
  } else if (pending) {
    status = 'undetermined';
  } else if (has('expired') && !has('supported') && !outcomes.some((o) => o.value !== undefined)) {
    status = 'expired';
  } else if (has('expired')) {
    status = 'expired';
  } else {
    status = 'undetermined';
  }

  const resolvedAt =
    status === 'supported' || status === 'contradicted'
      ? outcomes
          .map((o) => byObservable.get(o.observable.id)?.observedAt)
          .filter((at): at is string => at !== undefined)
          .sort()
          .at(-1)
      : undefined;

  return {
    status,
    outcomes,
    explanation: explain(status, outcomes),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(status === 'supported' ? { outcome: true } : {}),
    ...(status === 'contradicted' ? { outcome: false } : {}),
  };
}

function explain(status: HypothesisStatus, outcomes: readonly ObservableOutcome[]): string {
  const decisive = outcomes.find((o) => o.status === status) ?? outcomes[0];
  switch (status) {
    case 'contradicted':
      return `refuted: ${decisive?.observable.name} — ${decisive?.reason}`;
    case 'supported':
      return `supported: ${outcomes.map((o) => o.reason).join('; ')}`;
    case 'expired':
      return `expired: ${outcomes
        .filter((o) => o.status === 'expired')
        .map((o) => o.reason)
        .join('; ')}`;
    default:
      return `open: ${outcomes.map((o) => o.reason).join('; ')}`;
  }
}
