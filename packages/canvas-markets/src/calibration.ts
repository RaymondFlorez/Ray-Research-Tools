/**
 * Market and platform calibration (PRD 5.6).
 *
 * "the platform tracks its own and the market's calibration on resolved
 * contracts, producing reliability diagrams and Brier decompositions. This
 * feeds directly into the hypothesis tracker."
 *
 * The Brier machinery already exists in `@picasso/canvas-hypothesis`, and
 * reusing it rather than writing a second copy is the point of the sentence:
 * the analyst's own calls and the market's prices are scored by the same rule,
 * so "am I better than the market on this kind of question" is a subtraction
 * rather than an argument.
 *
 * The comparison is the reason to build this at all, and it has one honest
 * requirement: **the two have to be scored on the same contracts.** An analyst
 * who states a probability on the twelve questions they find interesting and
 * compares their Brier to the market's across four hundred is measuring
 * question selection, not skill. `compare` therefore intersects the two sets
 * and reports how many contracts survived.
 */

import { calibrate, MIN_SCORED, type Calibration, type Scored } from '@picasso/canvas-hypothesis';

export interface ResolvedContract {
  contractId: string;
  event: string;
  /** What the market said, at the reference time. */
  marketProbability: number;
  /** What the analyst said, where they said anything. */
  analystProbability?: number;
  /** What happened. */
  outcome: boolean;
  resolvedAt: string;
  venue?: string;
}

export interface SideCalibration {
  label: string;
  calibration: Calibration;
  scored: Scored[];
}

export interface Comparison {
  /** Contracts both the market and the analyst have a number on. */
  overlap: number;
  market: SideCalibration;
  analyst: SideCalibration;
  /** Analyst Brier minus market Brier. Negative means the analyst is ahead. */
  edge: number;
  /** The sentence the hypothesis tracker shows. */
  verdict: string;
}

export function marketScored(contracts: readonly ResolvedContract[]): Scored[] {
  return contracts.map((c) => ({
    confidence: c.marketProbability,
    outcome: c.outcome,
    id: c.contractId,
    resolvedAt: c.resolvedAt,
  }));
}

export function analystScored(contracts: readonly ResolvedContract[]): Scored[] {
  return contracts
    .filter((c) => c.analystProbability !== undefined)
    .map((c) => ({
      confidence: c.analystProbability as number,
      outcome: c.outcome,
      id: c.contractId,
      resolvedAt: c.resolvedAt,
    }));
}

/**
 * Score both sides on the contracts they both spoke about.
 *
 * The intersection is not a technicality. An analyst who quotes a probability
 * on the twelve questions they find interesting and compares themselves to the
 * market across four hundred is measuring which questions they chose, and the
 * answer will flatter them.
 */
export function compare(contracts: readonly ResolvedContract[]): Comparison {
  const both = contracts.filter((c) => c.analystProbability !== undefined);
  const market = calibrate(marketScored(both));
  const analyst = calibrate(analystScored(both));
  const edge = analyst.brier - market.brier;

  return {
    overlap: both.length,
    market: { label: 'market', calibration: market, scored: marketScored(both) },
    analyst: { label: 'analyst', calibration: analyst, scored: analystScored(both) },
    edge,
    verdict: verdictFor(both.length, edge, analyst, market),
  };
}

function verdictFor(overlap: number, edge: number, analyst: Calibration, market: Calibration): string {
  if (overlap === 0) return 'no contract carries both a market price and a stated view';
  if (overlap < MIN_SCORED) {
    return `${overlap} overlapping contract${overlap === 1 ? '' : 's'}: too few to score, ` +
      `and the count is shown instead of a number that would not mean anything`;
  }
  const points = Math.abs(edge).toFixed(3);
  if (Math.abs(edge) < 0.005) {
    return `${overlap} contracts: Brier ${analyst.brier.toFixed(3)} against the market's ${market.brier.toFixed(3)} — no measurable edge`;
  }
  return edge < 0
    ? `${overlap} contracts: ahead of the market by ${points} Brier`
    : `${overlap} contracts: behind the market by ${points} Brier`;
}
