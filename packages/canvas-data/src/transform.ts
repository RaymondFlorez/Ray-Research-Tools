/**
 * `TransformNode`'s declarative ops (PRD 3.3).
 *
 * > `TransformNode`: declarative ops (resample, z-score, lag, winsorize,
 * > currency convert) with no code.
 *
 * The port checker in `canvas-core` already offers "insert a resample node"
 * as the fix for a frequency mismatch; this is the node it inserts.
 *
 * Every op here is written so it cannot look ahead, because a transform sits
 * upstream of backtests and a leak introduced by a convenience op is the
 * hardest kind to find:
 *
 * - **resample** going coarser dates each bucket by its last observation —
 *   the day its value was known — not by the bucket's end. Going finer is
 *   what PRD 3.4.5's own example asks for (a daily series into an intraday
 *   port, fixed by "insert resample node"), and it is allowed one way only:
 *   carrying the last known value forward onto a grid the caller supplies,
 *   which is the `latest()` adapter applied per point. Interpolating would
 *   read the next observation, and a mean or sum over a finer period has
 *   nothing to average, so both are refused.
 * - **lag** refuses a negative shift. A lead is the value from the future.
 * - **z-score** and **winsorize** use the trailing window only, never the
 *   full sample: a full-sample winsorize clips 2019 at quantiles that include
 *   2020.
 * - **convert_currency** is an as-of join: each date uses the last rate
 *   known on or before it, and a date before the first rate is refused, not
 *   back-filled.
 *
 * Each output records the ops applied, in words, so the node shows what was
 * done to the series without anyone reading code.
 */

import type { Frequency } from '@picasso/canvas-core';
import { median, robustScale } from './anomaly.js';

export interface SeriesPoint {
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  value: number;
}

export interface DataSeries {
  points: readonly SeriesPoint[];
  frequency: Frequency;
  currency?: string;
  /** Plain-language record of every op applied, oldest first. */
  steps?: readonly string[];
}

export type TransformOp =
  /**
   * `how` is required: the last price of a month and the sum of a month's
   * flows are both "monthly", and a default would be right for one and
   * silently wrong for the other.
   */
  | { op: 'resample'; to: Frequency; how: 'last' | 'first' | 'mean' | 'sum' }
  /** Going finer: each `grid` date takes the last value known on or before it. */
  | { op: 'resample'; to: Frequency; how: 'carry'; grid: readonly string[] }
  | { op: 'lag'; periods: number }
  | { op: 'zscore'; window: number; robust?: boolean }
  | { op: 'winsorize'; window: number; lower: number; upper: number }
  /** `rates` is units of `to` per unit of the series' currency. */
  | { op: 'convert_currency'; to: string; rates: DataSeries };

export class TransformRefused extends Error {
  constructor(readonly op: TransformOp['op'], readonly detail: string) {
    super(`${op} refused: ${detail}`);
    this.name = 'TransformRefused';
  }
}

const ORDER: readonly Frequency[] = ['tick', 'intraday', 'daily', 'weekly', 'monthly', 'quarterly', 'annual'];

/** The bucket a date falls in at a coarser frequency. */
function bucketOf(date: string, to: Frequency): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  switch (to) {
    case 'weekly': {
      // ISO weeks run Monday to Sunday; the bucket is named by its Monday.
      const ms = Date.UTC(y, m - 1, d);
      const weekday = (new Date(ms).getUTCDay() + 6) % 7;
      return new Date(ms - weekday * 86_400_000).toISOString().slice(0, 10);
    }
    case 'monthly':
      return `${y}-${String(m).padStart(2, '0')}`;
    case 'quarterly':
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case 'annual':
      return `${y}`;
    default:
      return date;
  }
}

function resample(series: DataSeries, op: Extract<TransformOp, { op: 'resample' }>): DataSeries {
  const from = ORDER.indexOf(series.frequency);
  const to = ORDER.indexOf(op.to);
  if (from <= 1) throw new TransformRefused('resample', `${series.frequency} data needs timestamps, and these points carry dates`);
  if (to < from) {
    if (op.how !== 'carry') {
      throw new TransformRefused(
        'resample',
        `${series.frequency} to ${op.to} by '${op.how}' would invent the observations in between; ` +
          `going finer can only carry the last known value forward`,
      );
    }
    if (to <= 1) throw new TransformRefused('resample', `${op.to} needs timestamps, and these points carry dates`);
    const grid = [...op.grid].sort();
    const points: SeriesPoint[] = [];
    let k = -1;
    for (const date of grid) {
      while (k + 1 < series.points.length && series.points[k + 1]!.date <= date) k += 1;
      // A grid date before the first observation has no known value; it is
      // dropped, not back-filled.
      if (k >= 0) points.push({ date, value: series.points[k]!.value });
    }
    return { ...series, points, frequency: op.to };
  }
  if (op.how === 'carry') {
    throw new TransformRefused('resample', `'carry' fills a finer grid; ${series.frequency} to ${op.to} is coarser, so take the last`);
  }
  if (to === from) return series;
  const buckets = new Map<string, SeriesPoint[]>();
  for (const point of series.points) {
    const key = bucketOf(point.date, op.to);
    buckets.set(key, [...(buckets.get(key) ?? []), point]);
  }
  const points: SeriesPoint[] = [];
  for (const members of buckets.values()) {
    const values = members.map((p) => p.value);
    const value =
      op.how === 'last' ? values[values.length - 1]! :
      op.how === 'first' ? values[0]! :
      op.how === 'sum' ? values.reduce((a, b) => a + b, 0) :
      values.reduce((a, b) => a + b, 0) / values.length;
    // Dated by the last observation: the day the bucket's value was known.
    points.push({ date: members[members.length - 1]!.date, value });
  }
  return { ...series, points, frequency: op.to };
}

function lag(series: DataSeries, periods: number): DataSeries {
  if (!Number.isInteger(periods) || periods < 0) {
    throw new TransformRefused('lag', `a shift of ${periods} reads ${periods < 0 ? 'the future' : 'between observations'}`);
  }
  const points = series.points.slice(periods).map((p, i) => ({ date: p.date, value: series.points[i]!.value }));
  return { ...series, points };
}

function zscore(series: DataSeries, window: number, robust: boolean): DataSeries {
  if (!Number.isInteger(window) || window < 2) throw new TransformRefused('zscore', `a window of ${window} has no dispersion`);
  const values = series.points.map((p) => p.value);
  const points: SeriesPoint[] = [];
  for (let i = window; i < values.length; i += 1) {
    const base = values.slice(i - window, i);
    let centre: number;
    let scale: number;
    if (robust) {
      centre = median(base);
      scale = robustScale(base);
    } else {
      centre = base.reduce((a, b) => a + b, 0) / window;
      scale = Math.sqrt(base.reduce((a, b) => a + (b - centre) ** 2, 0) / (window - 1));
    }
    // A window with no dispersion scores nothing rather than infinity.
    points.push({ date: series.points[i]!.date, value: scale > 0 ? (values[i]! - centre) / scale : Number.NaN });
  }
  // A z-score is in standard deviations, so the currency does not survive it.
  return { points, frequency: series.frequency, ...(series.steps ? { steps: series.steps } : {}) };
}

/** Linear-interpolated quantile of a sorted array. */
function quantile(sorted: readonly number[], q: number): number {
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function winsorize(series: DataSeries, op: Extract<TransformOp, { op: 'winsorize' }>): DataSeries {
  if (!(op.lower >= 0 && op.lower < op.upper && op.upper <= 1)) {
    throw new TransformRefused('winsorize', `quantiles ${op.lower} and ${op.upper} must satisfy 0 <= lower < upper <= 1`);
  }
  if (!Number.isInteger(op.window) || op.window < 2) throw new TransformRefused('winsorize', `a window of ${op.window} has no quantiles`);
  const values = series.points.map((p) => p.value);
  const points: SeriesPoint[] = [];
  for (let i = op.window; i < values.length; i += 1) {
    const sorted = values.slice(i - op.window, i).sort((a, b) => a - b);
    const lo = quantile(sorted, op.lower);
    const hi = quantile(sorted, op.upper);
    points.push({ date: series.points[i]!.date, value: Math.min(hi, Math.max(lo, values[i]!)) });
  }
  return { ...series, points };
}

function convert(series: DataSeries, op: Extract<TransformOp, { op: 'convert_currency' }>): DataSeries {
  if (series.currency === undefined) {
    throw new TransformRefused('convert_currency', 'the series carries no currency, so there is nothing to convert from');
  }
  if (series.currency === op.to) return series;
  const rates = [...op.rates.points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const points: SeriesPoint[] = [];
  let r = -1;
  for (const point of series.points) {
    while (r + 1 < rates.length && rates[r + 1]!.date <= point.date) r += 1;
    if (r < 0) {
      throw new TransformRefused('convert_currency', `no ${series.currency}/${op.to} rate is known on or before ${point.date}`);
    }
    points.push({ date: point.date, value: point.value * rates[r]!.value });
  }
  return { ...series, points, currency: op.to };
}

function describe(op: TransformOp): string {
  switch (op.op) {
    case 'resample':
      return op.how === 'carry'
        ? `resampled to ${op.to}, carrying the last known value forward`
        : `resampled to ${op.to}, taking the ${op.how} of each period, dated by its last observation`;
    case 'lag':
      return `lagged ${op.periods} period${op.periods === 1 ? '' : 's'}`;
    case 'zscore':
      return `${op.robust ? 'robust ' : ''}z-scored against the ${op.window} observations before each point`;
    case 'winsorize':
      return `winsorized at the ${op.lower}–${op.upper} quantiles of the ${op.window} observations before each point`;
    case 'convert_currency':
      return `converted to ${op.to} at the last rate known on each date`;
  }
}

/** Applies the ops in order. Each one's description is appended to `steps`. */
export function applyTransforms(series: DataSeries, ops: readonly TransformOp[]): DataSeries {
  let current = series;
  for (const op of ops) {
    const next =
      op.op === 'resample' ? resample(current, op) :
      op.op === 'lag' ? lag(current, op.periods) :
      op.op === 'zscore' ? zscore(current, op.window, op.robust ?? false) :
      op.op === 'winsorize' ? winsorize(current, op) :
      convert(current, op);
    const cleaned: DataSeries = { points: next.points, frequency: next.frequency, steps: [...(current.steps ?? []), describe(op)] };
    if (next.currency !== undefined) (cleaned as { currency?: string }).currency = next.currency;
    current = cleaned;
  }
  return current;
}
