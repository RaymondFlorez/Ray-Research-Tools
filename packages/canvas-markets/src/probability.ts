/**
 * The probability curve (PRD 5.6).
 *
 * "`ProbabilityCurveNode`: the market-implied probability path for an event
 * over time, with resolution criteria text attached so the analyst can see
 * exactly what the contract settles on. **Most prediction market mistakes are
 * resolution-criteria mistakes**, so the criteria are first-class, not a
 * footnote."
 *
 * "First-class, not a footnote" is only true if it is enforced somewhere. A
 * criteria field that can be left empty is a footnote with a longer name, so
 * `curve()` refuses to build without one — the same move `present()` makes in
 * `canvas-guard` for source and as-of. The failure mode this guards against is
 * specific and common: two venues list what looks like the same contract, the
 * prices differ by eight points, and the difference is entirely that one
 * settles on the BLS print and the other on a revision. An analyst who cannot
 * see both settlement texts reads that spread as an opportunity.
 *
 * Which is also why `crossVenue` refuses to call anything a divergence until
 * the criteria have been compared. A price gap between contracts that settle
 * differently is not a divergence; it is two different questions.
 */

import { liquidityWeightedMid, spreadBand, type MarketType, type Quote } from './devig.js';

export interface ResolutionCriteria {
  /** What the contract settles on, in the venue's own words. */
  text: string;
  /** The source that decides it, where the contract names one. */
  source?: string;
  /** When it settles. */
  settlesAt: string;
  /** Free-form settlement wrinkles the analyst should see: revisions, ties. */
  notes?: string[];
}

export class MissingResolutionCriteria extends Error {
  constructor(readonly venue: string) {
    super(
      `a probability curve for ${venue} needs its resolution criteria; ` +
        'most prediction market mistakes are resolution-criteria mistakes',
    );
    this.name = 'MissingResolutionCriteria';
  }
}

export interface ProbabilityPoint {
  at: string;
  probability: number;
  /** Half-width from the spread, where a book was available. */
  band?: number;
  /** Total size resting on the book, for the confidence weight. */
  depth?: number;
}

export interface CurveInput {
  venue: string;
  marketType: MarketType;
  event: string;
  criteria: ResolutionCriteria;
  points: readonly ProbabilityPoint[];
}

export interface ProbabilityCurve extends CurveInput {
  latest: ProbabilityPoint;
  /** 0 to 1. Wide spreads and thin books cost confidence. */
  confidence: number;
  /** What the confidence number is made of, so it is arguable. */
  confidenceReason: string;
}

/**
 * Liquidity-weighted confidence.
 *
 * Two inputs, multiplied rather than averaged: a tight spread on a book with
 * nothing on it is not a confident price, and neither is a deep book quoted
 * ten points wide. Averaging would let either one carry the number alone.
 */
export const REFERENCE_DEPTH = 25_000;
export const WIDE_SPREAD = 0.05;

export function confidenceOf(point: ProbabilityPoint): { value: number; reason: string } {
  const band = point.band ?? WIDE_SPREAD;
  const depth = point.depth ?? 0;
  // A spread at or beyond the wide threshold contributes nothing.
  const tightness = Math.max(0, 1 - (2 * band) / WIDE_SPREAD);
  // Saturating rather than linear: past the reference depth, more size stops
  // telling you anything new about whether the price is real.
  const liquidity = depth / (depth + REFERENCE_DEPTH);
  const value = tightness * liquidity;
  return {
    value,
    reason:
      `spread ${(2 * band * 100).toFixed(1)} points (${(tightness * 100).toFixed(0)}% of tight), ` +
      `depth ${Math.round(depth).toLocaleString('en-US')} (${(liquidity * 100).toFixed(0)}% of reference)`,
  };
}

export function curve(input: CurveInput): ProbabilityCurve {
  if (input.criteria.text.trim() === '') throw new MissingResolutionCriteria(input.venue);
  if (input.criteria.settlesAt.trim() === '') throw new MissingResolutionCriteria(input.venue);
  if (input.points.length === 0) {
    throw new Error(`a probability curve for ${input.venue} needs at least one point`);
  }
  const ordered = [...input.points].sort((a, b) => a.at.localeCompare(b.at));
  const latest = ordered[ordered.length - 1]!;
  const { value, reason } = confidenceOf(latest);
  return { ...input, points: ordered, latest, confidence: value, confidenceReason: reason };
}

/** Build the latest point straight from a book. */
export function pointFromBook(at: string, quote: Quote): ProbabilityPoint {
  const depth = (quote.bidSize ?? 0) + (quote.askSize ?? 0);
  return {
    at,
    probability: liquidityWeightedMid(quote),
    band: spreadBand(quote),
    ...(depth > 0 ? { depth } : {}),
  };
}

// ---------------------------------------------------------------------------
// Cross-venue divergence
// ---------------------------------------------------------------------------

export type DivergenceVerdict = 'aligned' | 'divergent' | 'different_questions';

export interface CrossVenue {
  verdict: DivergenceVerdict;
  gapBps: number;
  /** Venue and probability, richest book first. */
  quotes: Array<{ venue: string; probability: number; confidence: number }>;
  explanation: string;
  /** The criteria that differ, when they do. */
  criteriaGap?: Array<{ venue: string; text: string; source?: string; settlesAt: string }>;
}

/** Gap above which two venues quoting the same question is worth a look. */
export const CROSS_VENUE_BPS = 200;

/**
 * Compare the same event across venues.
 *
 * The criteria check runs *first* and can stop the comparison outright. A
 * spread between two contracts that settle on different sources is not an
 * arbitrage and not a signal; treating it as one is the single most common way
 * to lose money in these markets, and it is exactly what a node that showed
 * only prices would invite.
 */
export function crossVenue(curves: readonly ProbabilityCurve[]): CrossVenue {
  if (curves.length < 2) {
    return {
      verdict: 'aligned',
      gapBps: 0,
      quotes: curves.map((c) => ({
        venue: c.venue,
        probability: c.latest.probability,
        confidence: c.confidence,
      })),
      explanation: 'only one venue quotes this event',
    };
  }

  const quotes = [...curves]
    .sort((a, b) => b.confidence - a.confidence)
    .map((c) => ({ venue: c.venue, probability: c.latest.probability, confidence: c.confidence }));
  const probabilities = curves.map((c) => c.latest.probability);
  const gapBps = Math.round((Math.max(...probabilities) - Math.min(...probabilities)) * 10_000);

  const settlements = new Set(curves.map((c) => settlementKey(c.criteria)));
  if (settlements.size > 1) {
    return {
      verdict: 'different_questions',
      gapBps,
      quotes,
      explanation:
        'these contracts do not settle on the same thing, so the gap between them is not a divergence. ' +
        'Compare the resolution criteria before comparing the prices.',
      criteriaGap: curves.map((c) => ({
        venue: c.venue,
        text: c.criteria.text,
        ...(c.criteria.source !== undefined ? { source: c.criteria.source } : {}),
        settlesAt: c.criteria.settlesAt,
      })),
    };
  }

  if (gapBps <= CROSS_VENUE_BPS) {
    return { verdict: 'aligned', gapBps, quotes, explanation: 'the venues agree within the noise of their spreads' };
  }

  const best = quotes[0]!;
  return {
    verdict: 'divergent',
    gapBps,
    quotes,
    explanation:
      `${gapBps} basis points apart on identical settlement terms. ` +
      `${best.venue} carries the better book and quotes ${(best.probability * 100).toFixed(1)}%.`,
  };
}

function settlementKey(criteria: ResolutionCriteria): string {
  // Normalized so a difference in whitespace or case is not a difference in
  // the contract, and a difference in the deciding source always is.
  return [criteria.text.trim().toLowerCase().replace(/\s+/g, ' '), criteria.source ?? '', criteria.settlesAt].join(
    '|',
  );
}
