/**
 * Corporate actions (PRD 5.1).
 *
 * "Corporate actions are applied as a versioned adjustment series so a price
 * series can be requested raw or adjusted, with the adjustment factors
 * themselves exposed as an output port. Analysts who have been burned by silent
 * restatements can wire the adjustment series into a chart and see exactly what
 * changed."
 *
 * The design follows from that last sentence. Most systems bake adjustment into
 * the price and hand back one number, which means an analyst who sees a series
 * change under them has no way to ask why. Here the factors are data: a first
 * class series, point-in-time like everything else, that can be charted next to
 * the price it modifies.
 *
 * Adjustment is also *knowledge-time dependent*, which is the subtle part. A
 * split announced in March changes the shape of every price before it — but
 * only from March onwards. Standing in February, the unadjusted series is
 * correct. A backtest that adjusts February's prices for a split nobody knew
 * about yet is looking into the future.
 */

import { BitemporalStore, type Instant, type Observation } from './bitemporal.js';

export type ActionKind = 'split' | 'dividend' | 'spinoff' | 'rights';

export interface CorporateAction {
  instrument: string;
  kind: ActionKind;
  /** The date the action takes effect: the ex-date. */
  exDate: Instant;
  /** When the market learned of it: the announcement. */
  announcedAt: Instant;
  /**
   * Price multiplier applied to everything strictly before the ex-date.
   * A 2-for-1 split is 0.5; a $1 dividend on a $50 stock is 0.98.
   */
  factor: number;
  /** Free text for the node's tooltip: "2-for-1 split", "$0.42 quarterly". */
  description?: string;
}

export interface AdjustmentPoint {
  /** Cumulative factor to apply to the raw price at this date. */
  factor: number;
  validTime: Instant;
}

export interface AdjustedSeriesOptions {
  /** Only actions announced at or before this instant are applied. */
  knowledgeTime: Instant;
  /**
   * The basis to adjust onto. Defaults to the knowledge time, which means
   * "current share terms as of this read".
   *
   * Defaulting to the last point of the series instead would make the same
   * instrument show different price levels in two charts with different
   * windows — a chart ending before a split would stay on the old basis while
   * the one beside it did not. The basis is a property of when you are
   * standing, not of how much history you asked for.
   */
  adjustTo?: Instant;
}

function compare(a: Instant, b: Instant): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The cumulative adjustment factor for each date in `dates`.
 *
 * Working backwards from the reference date: a price on a date before an ex-date
 * is multiplied by that action's factor, and by every later action's factor too.
 * Prices at or after the reference date are unadjusted, factor 1.
 */
export function adjustmentFactors(
  actions: readonly CorporateAction[],
  dates: readonly Instant[],
  options: AdjustedSeriesOptions,
): AdjustmentPoint[] {
  const { knowledgeTime } = options;
  const reference = options.adjustTo ?? knowledgeTime;

  // Only actions the market knew about, and only those at or before the
  // reference date: a future split does not reshape today's chart.
  const known = actions
    .filter((action) => compare(action.announcedAt, knowledgeTime) <= 0)
    .filter((action) => compare(action.exDate, reference) <= 0)
    .sort((a, b) => compare(a.exDate, b.exDate));

  return dates.map((date) => {
    let factor = 1;
    for (const action of known) {
      // A price strictly before the ex-date is on the old basis.
      if (compare(date, action.exDate) < 0) factor *= action.factor;
    }
    return { validTime: date, factor };
  });
}

export interface PriceSeries {
  instrument: string;
  points: Observation<number>[];
}

export interface AdjustedSeries extends PriceSeries {
  /** The factors used, exposed so they can be charted next to the price. */
  factors: AdjustmentPoint[];
  /** Actions that were applied, for the node's tooltip. */
  applied: CorporateAction[];
}

/**
 * Applies adjustment, and hands back the factors alongside the prices.
 *
 * Returning the factors is the whole design: a series that changed shape can be
 * explained rather than merely observed.
 */
export function adjustSeries(
  series: PriceSeries,
  actions: readonly CorporateAction[],
  options: AdjustedSeriesOptions,
): AdjustedSeries {
  const dates = series.points.map((p) => p.validTime);
  const factors = adjustmentFactors(actions, dates, options);
  const reference = options.adjustTo ?? options.knowledgeTime;

  const applied = actions
    .filter((action) => compare(action.announcedAt, options.knowledgeTime) <= 0)
    .filter((action) => compare(action.exDate, reference) <= 0)
    .sort((a, b) => compare(a.exDate, b.exDate));

  return {
    instrument: series.instrument,
    points: series.points.map((point, i) => ({
      ...point,
      value: point.value * ((factors[i] as AdjustmentPoint).factor),
    })),
    factors,
    applied,
  };
}

/**
 * Stores actions bitemporally, so "what did the adjusted chart look like on a
 * given morning" is answerable rather than approximated.
 */
export class CorporateActionStore {
  private readonly store = new BitemporalStore<CorporateAction>();

  add(action: CorporateAction): void {
    this.store.append({
      key: action.instrument,
      validTime: action.exDate,
      knowledgeTime: action.announcedAt,
      value: action,
      source: 'corporate-actions',
    });
  }

  addAll(actions: Iterable<CorporateAction>): void {
    for (const action of actions) this.add(action);
  }

  /** Actions for an instrument as known at `knowledgeTime`. */
  known(instrument: string, knowledgeTime: Instant): CorporateAction[] {
    return this.store
      .asOf({ key: instrument, knowledgeTime })
      .map((observation) => observation.value);
  }

  get size(): number {
    return this.store.size;
  }
}
