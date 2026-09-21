/**
 * Chart interaction: crosshair, range select, and the decimation both rest on
 * (PRD 7.1, 3.3).
 *
 * > | Chart interaction (crosshair, range select) | 12ms | 30ms | 60ms |
 *
 * Twelve milliseconds is a pointer-move budget, and it is the number that
 * decides every choice in this file. A series port is "time-indexed numeric"
 * and the PRD elsewhere sizes a local query at five million rows, so the
 * implementation that reads naturally — walk the points, find the closest —
 * is off the budget by three orders of magnitude before anything is drawn.
 *
 * Four decisions, each of which could have gone the other way.
 *
 * **Binary search, because the time axis is sorted.** A crosshair is a lookup,
 * not a scan. `nearestIndex` is the only part of this file that touches the
 * whole series and it touches `log2(n)` of it — 23 comparisons on five million
 * points rather than five million.
 *
 * **Nearest is decided in screen space.** While the time axis is affine this is
 * the same answer as comparing timestamps, and saying otherwise would be a
 * claim with no test behind it — the first version of that test asserted a
 * difference that cannot exist under a linear map. What the pixel comparison
 * buys is that it stays correct when the mapping stops being affine, and for
 * financial charts it does: a trading-time axis collapses weekends and
 * holidays, so equal pixel distances are unequal spans of wall-clock time and
 * the analyst is still pointing at a pixel. The cost of being right in advance
 * is two conversions per lookup.
 *
 * **The readout is the last observation at or before the cursor, never an
 * interpolation.** Series on one chart have different frequencies — a daily
 * price against a quarterly fundamental — and a chart that interpolated would
 * put a gross margin on a Tuesday in February that the company never reported.
 * Step semantics, and a series whose first point is after the cursor reads as
 * absent rather than as its first value.
 *
 * **Min/max decimation, not largest-triangle-three-buckets.** LTTB draws a
 * prettier line and it drops extremes, because an extreme is one point and the
 * triangle heuristic prefers points that describe the shape. On financial data
 * the extreme *is* the shape: a spike to an intraday low is the thing the
 * analyst is looking for, and a decimation that smooths it away has removed the
 * reason to draw the chart. Min/max keeps both ends of every pixel column.
 */

import type { Rect } from '@picasso/canvas-core';

/** A time-indexed numeric series, ascending in `t`. */
export interface Series {
  id: string;
  /** Milliseconds since the epoch, strictly ascending. */
  t: Float64Array | number[];
  v: Float64Array | number[];
  /** For the readout. */
  label?: string;
  unit?: string;
}

/** The chart's data domain and the pixels it is drawn into. */
export interface ChartView {
  /** Inclusive time domain. */
  t0: number;
  t1: number;
  /** Value domain. */
  v0: number;
  v1: number;
  /** Plot area in screen pixels. */
  plot: Rect;
}

export function timeToX(view: ChartView, t: number): number {
  const span = view.t1 - view.t0;
  const fraction = span === 0 ? 0 : (t - view.t0) / span;
  return view.plot.minX + fraction * (view.plot.maxX - view.plot.minX);
}

export function xToTime(view: ChartView, x: number): number {
  const width = view.plot.maxX - view.plot.minX;
  const fraction = width === 0 ? 0 : (x - view.plot.minX) / width;
  return view.t0 + fraction * (view.t1 - view.t0);
}

/** Y grows downward on screen, so the value axis is flipped. */
export function valueToY(view: ChartView, v: number): number {
  const span = view.v1 - view.v0;
  const fraction = span === 0 ? 0.5 : (v - view.v0) / span;
  return view.plot.maxY - fraction * (view.plot.maxY - view.plot.minY);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Index of the last point at or before `t`, or `-1` when `t` precedes the
 * series.
 *
 * Binary search. This is the only function here that sees the whole series and
 * it is what keeps a five-million-point crosshair inside a pointer-move budget.
 */
export function lastAtOrBefore(series: Series, t: number): number {
  const times = series.t;
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0 || (times[0] as number) > t) return -1;

  while (lo < hi) {
    // Upper mid, so the loop converges on the last satisfying index.
    const mid = (lo + hi + 1) >> 1;
    if ((times[mid] as number) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Index of the point nearest `x` in *screen* space, or `-1` for an empty
 * series.
 *
 * Found by bracketing in data space and then comparing the two candidates in
 * pixels, which is the only place the distinction matters and costs two
 * conversions rather than a scan.
 */
export function nearestIndex(series: Series, view: ChartView, x: number): number {
  if (series.t.length === 0) return -1;
  const t = xToTime(view, x);
  const before = lastAtOrBefore(series, t);
  if (before === -1) return 0;
  if (before >= series.t.length - 1) return series.t.length - 1;

  const dBefore = Math.abs(timeToX(view, series.t[before] as number) - x);
  const dAfter = Math.abs(timeToX(view, series.t[before + 1] as number) - x);
  return dAfter < dBefore ? before + 1 : before;
}

export interface Readout {
  seriesId: string;
  label: string;
  /** Index into the series, or `-1` when the cursor precedes its first point. */
  index: number;
  /** Absent when the cursor precedes the series. */
  t?: number;
  v?: number;
  unit?: string;
  /** Screen position of the point, for drawing the marker. */
  x?: number;
  y?: number;
  /**
   * True when the point is older than the cursor by more than one step.
   *
   * A quarterly fundamental read on a Tuesday in February is three weeks stale
   * and the readout says so rather than presenting it as that day's value. The
   * alternative — interpolating — would put a number on the screen the company
   * never reported.
   */
  stale?: boolean;
}

export interface Crosshair {
  /** Snapped to the nearest point of the anchor series, when one is given. */
  x: number;
  t: number;
  readouts: Readout[];
}

export interface CrosshairOptions {
  /**
   * Series whose points the crosshair snaps to.
   *
   * Without it the crosshair sits wherever the pointer is, which is right for
   * a chart of several frequencies: snapping to the daily series would make
   * the quarterly readout jump for reasons the analyst cannot see. With it, a
   * single-series chart snaps to its points, which is what makes a sparse
   * series readable.
   */
  snapTo?: string;
  /** Treat a point older than this as stale, in milliseconds. */
  staleAfterMs?: number;
}

/**
 * Resolve a pointer position into one reading per series.
 *
 * Every series gets a readout, including the ones with nothing at the cursor:
 * a chart that silently dropped a series from the tooltip would look like the
 * series had ended.
 */
export function crosshairAt(
  series: readonly Series[],
  view: ChartView,
  x: number,
  options: CrosshairOptions = {},
): Crosshair {
  const clampedX = Math.min(Math.max(x, view.plot.minX), view.plot.maxX);
  let anchorX = clampedX;

  if (options.snapTo !== undefined) {
    const anchor = series.find((s) => s.id === options.snapTo);
    if (anchor && anchor.t.length > 0) {
      const index = nearestIndex(anchor, view, clampedX);
      anchorX = timeToX(view, anchor.t[index] as number);
    }
  }

  const t = xToTime(view, anchorX);
  const readouts: Readout[] = series.map((s) => {
    const index = lastAtOrBefore(s, t);
    if (index === -1) {
      return { seriesId: s.id, label: s.label ?? s.id, index: -1, ...(s.unit ? { unit: s.unit } : {}) };
    }
    const pointT = s.t[index] as number;
    const pointV = s.v[index] as number;
    const readout: Readout = {
      seriesId: s.id,
      label: s.label ?? s.id,
      index,
      t: pointT,
      v: pointV,
      x: timeToX(view, pointT),
      y: valueToY(view, pointV),
      ...(s.unit ? { unit: s.unit } : {}),
    };
    if (options.staleAfterMs !== undefined && t - pointT > options.staleAfterMs) {
      readout.stale = true;
    }
    return readout;
  });

  return { x: anchorX, t, readouts };
}

// ---------------------------------------------------------------------------
// Range select
// ---------------------------------------------------------------------------

/** Pixels a drag must cover before it is a range rather than a click. */
export const MIN_DRAG_PX = 4;

export interface RangeSelection {
  /** Half-open in time: `[t0, t1)`. */
  t0: number;
  t1: number;
  /** Screen bounds of the band, for drawing it. */
  x0: number;
  x1: number;
  /** Indices of the first and last point inside, per series. */
  spans: Array<{ seriesId: string; from: number; to: number; count: number }>;
}

/**
 * Turn a drag into a range, or `undefined` when it was a click.
 *
 * Normalized, so dragging right to left selects the same range as left to
 * right — a drag that produced an inverted or empty interval would have to be
 * handled by every caller, and there is no reading of "the analyst dragged
 * backwards" that means anything else.
 *
 * Half-open, because a range select feeds a filter and two adjacent selections
 * must not both contain the point on their shared boundary.
 */
export function rangeFromDrag(
  series: readonly Series[],
  view: ChartView,
  fromX: number,
  toX: number,
  minDragPx = MIN_DRAG_PX,
): RangeSelection | undefined {
  const a = Math.min(Math.max(fromX, view.plot.minX), view.plot.maxX);
  const b = Math.min(Math.max(toX, view.plot.minX), view.plot.maxX);
  const x0 = Math.min(a, b);
  const x1 = Math.max(a, b);
  if (x1 - x0 < minDragPx) return undefined;

  const t0 = xToTime(view, x0);
  const t1 = xToTime(view, x1);

  const spans = series.map((s) => {
    // First index at or after t0: one past the last strictly before it.
    const beforeStart = lastAtOrBefore(s, t0);
    const from =
      beforeStart >= 0 && (s.t[beforeStart] as number) === t0 ? beforeStart : beforeStart + 1;
    // Last index strictly before t1, since the interval is half-open.
    let to = lastAtOrBefore(s, t1);
    if (to >= 0 && (s.t[to] as number) >= t1) to -= 1;
    const count = to >= from ? to - from + 1 : 0;
    return { seriesId: s.id, from, to, count };
  });

  return { t0, t1, x0, x1, spans };
}

// ---------------------------------------------------------------------------
// Decimation
// ---------------------------------------------------------------------------

export interface DecimatedPoint {
  t: number;
  v: number;
  /** Index in the source series, so a crosshair on a drawn point is exact. */
  index: number;
}

/**
 * Reduce a series to at most two points per pixel column, keeping the extremes.
 *
 * Min/max rather than largest-triangle-three-buckets. LTTB draws a prettier
 * line and it drops extremes, because an extreme is one point and the triangle
 * heuristic prefers points that describe the shape. On a price series the
 * extreme *is* the shape — a spike to an intraday low is what the analyst is
 * looking at the chart for — and a decimation that smoothed it away would have
 * removed the reason to draw it.
 *
 * Emitted in time order within each column, so the polyline does not zigzag
 * backwards where the minimum happens to come after the maximum.
 */
export function decimate(series: Series, view: ChartView): DecimatedPoint[] {
  const times = series.t;
  const values = series.v;
  const n = times.length;
  if (n === 0) return [];

  const columns = Math.max(1, Math.round(view.plot.maxX - view.plot.minX));
  const first = Math.max(0, lastAtOrBefore(series, view.t0));
  let last = lastAtOrBefore(series, view.t1);
  if (last === -1) return [];
  last = Math.min(n - 1, last + 1);

  const inView = last - first + 1;
  if (inView <= columns * 2) {
    const out: DecimatedPoint[] = [];
    for (let i = first; i <= last; i += 1) {
      out.push({ t: times[i] as number, v: values[i] as number, index: i });
    }
    return out;
  }

  const out: DecimatedPoint[] = [];
  const perColumn = inView / columns;
  for (let column = 0; column < columns; column += 1) {
    const start = first + Math.floor(column * perColumn);
    const end = Math.min(last, first + Math.floor((column + 1) * perColumn) - 1);
    if (start > end) continue;

    let minIndex = start;
    let maxIndex = start;
    for (let i = start + 1; i <= end; i += 1) {
      const value = values[i] as number;
      if (value < (values[minIndex] as number)) minIndex = i;
      if (value > (values[maxIndex] as number)) maxIndex = i;
    }

    const lowFirst = minIndex <= maxIndex;
    const a = lowFirst ? minIndex : maxIndex;
    const b = lowFirst ? maxIndex : minIndex;
    out.push({ t: times[a] as number, v: values[a] as number, index: a });
    if (b !== a) out.push({ t: times[b] as number, v: values[b] as number, index: b });
  }
  return out;
}
