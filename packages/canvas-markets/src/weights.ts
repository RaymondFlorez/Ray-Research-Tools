/**
 * Probability as a scenario weight (PRD 5.6, Appendix C.4).
 *
 * "an event node with a market-implied probability wires into a `ScenarioNode`
 * as a probability weight, so 'Fed cuts in March at 34 percent' becomes an
 * actual weight in a portfolio expected-value calculation rather than a number
 * the analyst holds in their head."
 *
 * The moment a probability becomes a weight it stops being a display and
 * starts multiplying money, and two things follow that a display never had to
 * worry about.
 *
 * **The weights have to account for all of the probability.** A scenario set
 * whose weights sum to 0.7 is missing thirty percent of the outcome space, and
 * an expected value computed over it is not an estimate with wide error bars —
 * it is arithmetic that assumes the missing thirty percent is worth zero. So
 * `weigh` computes the residual explicitly and carries it, rather than
 * normalizing the stated weights up to one, which would silently spread the
 * unmodelled mass across the scenarios the analyst happened to think of.
 *
 * **C.4's divergence flag travels with the number.** "If the probability is
 * wired into a `ScenarioNode` as a weight, the flag renders inline on the
 * scenario node too, since that is the point where method choice becomes
 * load-bearing." A flag that stays on the probability node is a flag on the
 * screen the analyst has already stopped looking at.
 */

import type { Devigged } from './devig.js';
import type { ProbabilityCurve } from './probability.js';

export interface WeightedScenario {
  scenarioId: string;
  name: string;
  probability: number;
  /** Portfolio P&L under this scenario, once the grid has been revalued. */
  pnl?: number;
  source?: {
    venue: string;
    event: string;
    /** Carried so the scenario node can show what the weight settles on. */
    criteria: string;
    confidence: number;
  };
  /** C.4's flag, carried through from the de-vigged market. */
  divergence?: Devigged['divergence'];
}

export interface WeightedSet {
  scenarios: WeightedScenario[];
  /** Probability not accounted for by any stated scenario. */
  residual: number;
  /** True when the stated weights exceed one, which is a contradiction. */
  overweight: boolean;
  /** Flags carried up from any weight, so the scenario node renders them. */
  divergences: Array<{ scenarioId: string; explanation: string; gapBps: number }>;
  warnings: string[];
}

export const RESIDUAL_TOLERANCE = 1e-9;

export function weigh(scenarios: readonly WeightedScenario[]): WeightedSet {
  const stated = scenarios.reduce((total, s) => total + s.probability, 0);
  const residual = 1 - stated;
  const warnings: string[] = [];

  if (stated > 1 + RESIDUAL_TOLERANCE) {
    warnings.push(
      `the stated weights sum to ${stated.toFixed(3)}. These scenarios cannot all be mutually exclusive, ` +
        'so an expected value over them double-counts whatever they share.',
    );
  } else if (residual > 0.01) {
    warnings.push(
      `${(residual * 100).toFixed(1)}% of the probability is not covered by any scenario. ` +
        'Expected values below treat that mass as zero P&L, which is an assumption and not a measurement.',
    );
  }

  const divergences = scenarios
    .filter((s) => s.divergence !== undefined)
    .map((s) => ({
      scenarioId: s.scenarioId,
      explanation: (s.divergence as NonNullable<Devigged['divergence']>).explanation,
      gapBps: (s.divergence as NonNullable<Devigged['divergence']>).gapBps,
    }));

  for (const flag of divergences) {
    warnings.push(
      `the weight on ${flag.scenarioId} moves ${flag.gapBps} basis points depending on the de-vigging method. ` +
        'That choice is load-bearing here because the weight multiplies P&L.',
    );
  }

  return {
    scenarios: [...scenarios],
    residual: Math.max(0, residual),
    overweight: stated > 1 + RESIDUAL_TOLERANCE,
    divergences,
    warnings,
  };
}

export interface ExpectedValue {
  value: number;
  /** What the unmodelled mass contributes, which is zero, stated out loud. */
  residualMass: number;
  /** Contribution per scenario, so the analyst can see what drives it. */
  contributions: Array<{ scenarioId: string; weight: number; pnl: number; contribution: number }>;
  /** Range across stated scenarios, which is not a confidence interval. */
  worst: number;
  best: number;
  warnings: string[];
}

/**
 * Probability-weighted P&L.
 *
 * `worst` and `best` are the extremes of the stated scenarios and are labelled
 * as such rather than as a range: they are the worst and best things the
 * analyst *wrote down*, which is a different claim from the worst and best
 * things that can happen, and a scenario set is exactly the artefact where
 * those two get confused.
 */
export function expectedValue(set: WeightedSet): ExpectedValue {
  const priced = set.scenarios.filter((s) => s.pnl !== undefined);
  const contributions = priced.map((s) => ({
    scenarioId: s.scenarioId,
    weight: s.probability,
    pnl: s.pnl as number,
    contribution: s.probability * (s.pnl as number),
  }));
  const value = contributions.reduce((total, c) => total + c.contribution, 0);
  const pnls = contributions.map((c) => c.pnl);
  const warnings = [...set.warnings];
  if (priced.length < set.scenarios.length) {
    warnings.push(
      `${set.scenarios.length - priced.length} scenario(s) carry a weight but no revaluation, ` +
        'and contribute nothing to the expected value.',
    );
  }
  return {
    value,
    residualMass: set.residual,
    contributions,
    worst: pnls.length > 0 ? Math.min(...pnls) : Number.NaN,
    best: pnls.length > 0 ? Math.max(...pnls) : Number.NaN,
    warnings,
  };
}

/** Build a weight from a probability curve, carrying its criteria and flag. */
export function weightFromCurve(
  scenarioId: string,
  name: string,
  curve: ProbabilityCurve,
  options: { pnl?: number; divergence?: Devigged['divergence'] } = {},
): WeightedScenario {
  return {
    scenarioId,
    name,
    probability: curve.latest.probability,
    ...(options.pnl !== undefined ? { pnl: options.pnl } : {}),
    source: {
      venue: curve.venue,
      event: curve.event,
      criteria: curve.criteria.text,
      confidence: curve.confidence,
    },
    ...(options.divergence ? { divergence: options.divergence } : {}),
  };
}
