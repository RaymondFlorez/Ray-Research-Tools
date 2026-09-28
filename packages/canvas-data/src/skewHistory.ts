/**
 * Skew and its history (PRD 5.4).
 *
 * > **Vol analytics:** term structure, skew and its history, ...
 *
 * `canvas-pricing` reads one day's skew off one day's smile. A history is a
 * series of those, and a series of anything the market restates belongs in
 * the bitemporal store: a smile marked at the close and corrected overnight
 * has two risk reversals for the same day, and a backtest reading the history
 * as of that evening must see the first one.
 *
 * ## The delta is part of the series
 *
 * A 25-delta and a 10-delta risk reversal are different quantities — the
 * second is read further out in the wing — and a history that mixed them after a change of convention would show a regime
 * change that is a relabelling. The delta is in the key, so they cannot share
 * a series.
 *
 * ## Today is ranked against the days before it
 *
 * "Where is skew against its history" is a percentile, and including today in
 * the sample it is ranked against pulls every extreme reading towards the
 * middle: the highest skew ever recorded reads as the 99th percentile of a
 * fifty-day sample that contains it, rather than as the 100th of the
 * forty-nine before it. So the rank is over prior days only, and below twenty of them it
 * is not reported at all.
 */

import type { BitemporalStore, Instant, Observation } from './bitemporal.js';

export interface SkewPoint {
  /** Put vol less call vol at `delta`. */
  riskReversal: number;
  /** The wings against the middle. */
  butterfly: number;
  atmVol: number;
}

/** Fewer prior days than this, and a percentile is noise with a decimal point. */
export const MIN_HISTORY = 20;

export function skewKey(underlier: string, delta: number): string {
  return `skew:${underlier}:${Math.round(delta * 100)}d`;
}

export interface RecordSkew {
  underlier: string;
  /** The delta the risk reversal is quoted at: 0.25 for the usual convention. */
  delta: number;
  /** The trading day the smile was marked. */
  date: Instant;
  point: SkewPoint;
  /** When this reading became known: the mark, or the correction. */
  knownAt: Instant;
  source?: string;
}

export function recordSkew(store: BitemporalStore<SkewPoint>, input: RecordSkew): void {
  store.append({
    key: skewKey(input.underlier, input.delta),
    validTime: input.date,
    knowledgeTime: input.knownAt,
    value: { ...input.point },
    ...(input.source !== undefined ? { source: input.source } : {}),
  });
}

export interface SkewHistory {
  points: Observation<SkewPoint>[];
  latest?: Observation<SkewPoint>;
  /**
   * Where the latest risk reversal sits among the prior days' readings, 0 to
   * 1. Absent below `MIN_HISTORY` prior days.
   */
  percentile?: number;
  priorDays: number;
}

export interface SkewQuery {
  underlier: string;
  delta: number;
  from?: Instant;
  to?: Instant;
  /** Only readings known at or before this instant. */
  asof: Instant;
}

/**
 * The skew history as it stood at `asof`, and where the latest day ranks.
 *
 * Ties count half, so a flat history ranks today at the median rather than at
 * either end.
 */
export function skewHistory(store: BitemporalStore<SkewPoint>, query: SkewQuery): SkewHistory {
  const points = store.asOf({
    key: skewKey(query.underlier, query.delta),
    knowledgeTime: query.asof,
    ...(query.from !== undefined ? { from: query.from } : {}),
    ...(query.to !== undefined ? { to: query.to } : {}),
  });
  const latest = points[points.length - 1];
  const prior = points.slice(0, -1).map((p) => p.value.riskReversal);
  const history: SkewHistory = { points, priorDays: prior.length };
  if (latest) history.latest = latest;
  if (latest && prior.length >= MIN_HISTORY) {
    const today = latest.value.riskReversal;
    let below = 0;
    let ties = 0;
    for (const v of prior) {
      if (v < today) below += 1;
      else if (v === today) ties += 1;
    }
    history.percentile = (below + ties / 2) / prior.length;
  }
  return history;
}
