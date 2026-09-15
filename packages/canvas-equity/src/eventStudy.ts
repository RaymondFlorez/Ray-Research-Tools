/**
 * `EventStudyNode` (PRD 5.2).
 *
 * "CAR around a chosen event set with a configurable model: market model, FF3,
 * or matched-firm."
 *
 * The three benchmark models are the easy part. The part that decides whether
 * an event study means anything is the standard error, and the default one is
 * wrong in a specific, well-known way that this node refuses to be quiet
 * about.
 *
 * **Event-date clustering.** The usual cross-sectional t-test divides the mean
 * abnormal return by the cross-sectional standard error, which assumes the
 * abnormal returns are independent across firms. When the events share
 * calendar dates — an index rebalance, a Fed day, a sector-wide announcement,
 * or just "every Q4 earnings call" — that assumption can fail in the direction
 * that manufactures significance.
 *
 * The mechanism is narrower than "they share a date", and the simulation in
 * `test/eventStudy.test.ts` had to be corrected before it showed anything: if
 * the benchmark spans every common factor the firms load on, the residuals on
 * a shared date really are independent and clustering costs nothing. Measured
 * in that world, clustering moved the rejection rate from 3.3 percent to 5.3
 * percent — no effect at all.
 *
 * What breaks the test is common variation the benchmark **does not span**: an
 * industry shock a market model has never heard of, carried by all twenty
 * residuals on the same day. The cross-sectional standard error is then
 * computed from twenty copies of one draw. In that world the same test rejects
 * at 60 percent against a nominal five.
 *
 * So `eventStudy` reports the clustering, reports both standard errors, and
 * says which one it would use. The calendar-time (portfolio) standard error
 * groups same-day events before computing the cross-sectional variance, which
 * costs power and is correct.
 */

import { mean, ols, standardDeviation } from './ols.js';

export type BenchmarkModel = 'market_model' | 'ff3' | 'matched_firm';

export interface EventSpec {
  symbol: string;
  /** A session date present in `calendar`. */
  date: string;
}

export interface EventStudyInput {
  events: readonly EventSpec[];
  /** Ordered session dates. Relative day offsets are indices into this. */
  calendar: readonly string[];
  /** symbol -> date -> simple return. */
  returns: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** date -> market excess return. */
  market: ReadonlyMap<string, number>;
  /** date -> SMB and HML, for the FF3 model. */
  smb?: ReadonlyMap<string, number>;
  hml?: ReadonlyMap<string, number>;
  /** The matched control firm for an event, for the matched-firm model. */
  matched?: (event: EventSpec) => string | undefined;
  model: BenchmarkModel;
  /** Sessions before the event window used to fit the benchmark. */
  estimationWindow?: number;
  /** Gap between the estimation window and the event window. */
  gap?: number;
  /** Relative day offsets, inclusive. */
  window?: [number, number];
}

export interface EventResult {
  symbol: string;
  date: string;
  /** Abnormal return per relative day. */
  abnormal: Array<{ day: number; value: number }>;
  car: number;
  /** Benchmark fit quality over the estimation window. */
  rSquared: number;
  warning?: string;
}

export interface Clustering {
  /** Distinct calendar dates the events fall on. */
  distinctDates: number;
  events: number;
  /** Largest number of events sharing one date. */
  largestCluster: number;
  /** 1 when every event is on its own date; approaches 0 as they pile up. */
  spread: number;
  clustered: boolean;
  /**
   * Pairs of events whose event windows overlap in calendar time.
   *
   * A second, quieter form of the same problem, and one the measurement found
   * rather than the design anticipating it. Events on distinct dates look
   * unclustered by every count above, but an eleven-day window on events five
   * days apart overlaps by six days, and those overlapping days carry the same
   * unspanned shocks. Measured under the null, that alone took the rejection
   * rate from 3.3 percent to 9.3 percent.
   */
  overlappingPairs: number;
}

export interface EventStudy {
  model: BenchmarkModel;
  window: [number, number];
  results: EventResult[];
  /** Mean CAR across events. */
  caar: number;
  /** Naive cross-sectional t-statistic. Assumes independence across firms. */
  naiveT: number;
  /**
   * Calendar-time t-statistic: same-day events averaged into one observation
   * before the cross-sectional variance is taken.
   */
  calendarT: number;
  clustering: Clustering;
  /** Which statistic this node would report, and why. */
  recommended: 'naive' | 'calendar';
  warnings: string[];
}

/** Above this share of events sharing dates, the naive test is not usable. */
export const CLUSTER_SPREAD_FLOOR = 0.8;

function clusteringOf(
  events: readonly EventSpec[],
  index: ReadonlyMap<string, number>,
  window: readonly [number, number],
): Clustering {
  const byDate = new Map<string, number>();
  for (const event of events) byDate.set(event.date, (byDate.get(event.date) ?? 0) + 1);
  const distinctDates = byDate.size;
  const largestCluster = Math.max(0, ...byDate.values());
  const spread = events.length === 0 ? 1 : distinctDates / events.length;

  // Distinct dates whose windows still touch. Same-date pairs are already
  // counted above, so only strictly different dates are counted here.
  let overlappingPairs = 0;
  for (let i = 0; i < events.length; i += 1) {
    const a = index.get(events[i]!.date);
    if (a === undefined) continue;
    for (let j = i + 1; j < events.length; j += 1) {
      if (events[i]!.date === events[j]!.date) continue;
      const b = index.get(events[j]!.date);
      if (b === undefined) continue;
      if (a + window[0] <= b + window[1] && b + window[0] <= a + window[1]) overlappingPairs += 1;
    }
  }

  return {
    distinctDates,
    events: events.length,
    largestCluster,
    spread,
    clustered: spread < CLUSTER_SPREAD_FLOOR,
    overlappingPairs,
  };
}

export function eventStudy(input: EventStudyInput): EventStudy {
  const window = input.window ?? [-5, 5];
  const estimationWindow = input.estimationWindow ?? 120;
  const gap = input.gap ?? 10;
  const index = new Map(input.calendar.map((date, i) => [date, i]));
  const results: EventResult[] = [];
  const warnings: string[] = [];

  for (const event of input.events) {
    const anchor = index.get(event.date);
    const series = input.returns.get(event.symbol);
    if (anchor === undefined || !series) {
      warnings.push(`${event.symbol} on ${event.date}: no session or no return series`);
      continue;
    }

    const estimationEnd = anchor + window[0] - gap;
    const estimationStart = estimationEnd - estimationWindow;
    if (estimationStart < 0 || anchor + window[1] >= input.calendar.length) {
      warnings.push(`${event.symbol} on ${event.date}: not enough history around the event`);
      continue;
    }

    const fitted = fitBenchmark(input, event, series, estimationStart, estimationEnd);
    if (!fitted) {
      warnings.push(`${event.symbol} on ${event.date}: benchmark could not be fitted`);
      continue;
    }

    const abnormal: Array<{ day: number; value: number }> = [];
    let car = 0;
    for (let day = window[0]; day <= window[1]; day += 1) {
      const date = input.calendar[anchor + day];
      if (date === undefined) continue;
      const actual = series.get(date);
      if (actual === undefined) continue;
      const expected = fitted.expected(date);
      if (!Number.isFinite(expected)) continue;
      const value = actual - expected;
      abnormal.push({ day, value });
      car += value;
    }

    results.push({
      symbol: event.symbol,
      date: event.date,
      abnormal,
      car,
      rSquared: fitted.rSquared,
      ...(fitted.warning !== undefined ? { warning: fitted.warning } : {}),
    });
  }

  const cars = results.map((r) => r.car);
  const caar = mean(cars);
  const naiveT = tStat(cars);

  // Calendar time: same-day events become one observation, because they share
  // that day's market-wide surprise and are not independent draws.
  const byDate = new Map<string, number[]>();
  for (const result of results) {
    byDate.set(result.date, [...(byDate.get(result.date) ?? []), result.car]);
  }
  const portfolios = [...byDate.values()].map((group) => mean(group));
  const calendarT = tStat(portfolios);

  const clustering = clusteringOf(
    results.map((r) => ({ symbol: r.symbol, date: r.date })),
    index,
    window,
  );
  const recommended: 'naive' | 'calendar' = clustering.clustered ? 'calendar' : 'naive';
  if (clustering.clustered) {
    warnings.push(
      `${clustering.events} events fall on ${clustering.distinctDates} dates, the largest sharing ${clustering.largestCluster}. ` +
        'Same-day events share that day\'s market-wide surprise, so the cross-sectional test overstates significance. ' +
        `Reporting the calendar-time statistic (${calendarT.toFixed(2)}) rather than the naive one (${naiveT.toFixed(2)}).`,
    );
  }

  if (clustering.overlappingPairs > 0) {
    // Grouping by date does not fix this one: the dates genuinely differ, so
    // every event is its own calendar-time observation and the overlap
    // survives. Saying so is the only honest move available here.
    warnings.push(
      `${clustering.overlappingPairs} pair(s) of events have overlapping ${window[0]} to ${window[1]} day windows. ` +
        'Overlapping windows share the same unspanned shocks, which inflates the cross-sectional test, and ' +
        'the calendar-time statistic does not repair it because the dates differ. Widen the spacing or ' +
        'fit a calendar-time portfolio regression instead.',
    );
  }

  const weakFits = results.filter((r) => Number.isFinite(r.rSquared) && r.rSquared < 0.05);
  if (weakFits.length > 0) {
    warnings.push(
      `${weakFits.length} benchmark fit(s) have an R-squared below 0.05, so their "abnormal" return is mostly raw return.`,
    );
  }

  return {
    model: input.model,
    window,
    results,
    caar,
    naiveT,
    calendarT,
    clustering,
    recommended,
    warnings,
  };
}

function tStat(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const sd = standardDeviation(values);
  if (!Number.isFinite(sd) || sd === 0) return Number.NaN;
  return mean(values) / (sd / Math.sqrt(values.length));
}

interface Benchmark {
  expected: (date: string) => number;
  rSquared: number;
  warning?: string;
}

function fitBenchmark(
  input: EventStudyInput,
  event: EventSpec,
  series: ReadonlyMap<string, number>,
  start: number,
  end: number,
): Benchmark | undefined {
  const dates = input.calendar.slice(start, end);

  if (input.model === 'matched_firm') {
    // No regression at all: the control firm's return *is* the expectation.
    // That is the model's appeal — it assumes nothing about factor structure —
    // and its cost, which is that it inherits all of the control's own noise.
    const control = input.matched?.(event);
    const controlSeries = control === undefined ? undefined : input.returns.get(control);
    if (!controlSeries) return undefined;
    const paired = dates
      .map((date) => [series.get(date), controlSeries.get(date)] as const)
      .filter((pair): pair is readonly [number, number] => pair[0] !== undefined && pair[1] !== undefined);
    const residuals = paired.map(([a, b]) => a - b);
    const own = paired.map(([a]) => a);
    const tss = own.reduce((total, v) => total + (v - mean(own)) ** 2, 0);
    const rss = residuals.reduce((total, v) => total + v * v, 0);
    return {
      expected: (date) => controlSeries.get(date) ?? Number.NaN,
      rSquared: tss === 0 ? Number.NaN : 1 - rss / tss,
      warning:
        'a matched-firm benchmark carries the control firm\'s own idiosyncratic noise into every abnormal return',
    };
  }

  const y: number[] = [];
  const mkt: number[] = [];
  const smb: number[] = [];
  const hml: number[] = [];
  for (const date of dates) {
    const r = series.get(date);
    const m = input.market.get(date);
    if (r === undefined || m === undefined) continue;
    if (input.model === 'ff3') {
      const s = input.smb?.get(date);
      const h = input.hml?.get(date);
      if (s === undefined || h === undefined) continue;
      smb.push(s);
      hml.push(h);
    }
    y.push(r);
    mkt.push(m);
  }

  const columns = input.model === 'ff3' ? [mkt, smb, hml] : [mkt];
  const fit = ols(y, columns);
  if (fit.warning !== undefined) return undefined;

  const [alpha = 0, beta = 0, sBeta = 0, hBeta = 0] = fit.coefficients;
  return {
    expected: (date) => {
      const m = input.market.get(date);
      if (m === undefined) return Number.NaN;
      if (input.model === 'ff3') {
        const s = input.smb?.get(date);
        const h = input.hml?.get(date);
        if (s === undefined || h === undefined) return Number.NaN;
        return alpha + beta * m + sBeta * s + hBeta * h;
      }
      return alpha + beta * m;
    },
    rSquared: fit.rSquared,
  };
}
