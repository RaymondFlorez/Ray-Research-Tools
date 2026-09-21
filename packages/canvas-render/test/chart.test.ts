import { describe, expect, it } from 'vitest';
import {
  MIN_DRAG_PX,
  crosshairAt,
  decimate,
  lastAtOrBefore,
  nearestIndex,
  rangeFromDrag,
  timeToX,
  valueToY,
  xToTime,
  type ChartView,
  type Series,
} from '../src/chart.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

function view(over: Partial<ChartView> = {}): ChartView {
  return {
    t0: T0,
    t1: T0 + 100 * DAY,
    v0: 0,
    v1: 100,
    plot: { minX: 0, minY: 0, maxX: 1000, maxY: 400 },
    ...over,
  };
}

/** A daily series over `days`, with a shape that has a real spike in it. */
function daily(days: number, id = 'px'): Series {
  const t = new Float64Array(days);
  const v = new Float64Array(days);
  for (let i = 0; i < days; i += 1) {
    t[i] = T0 + i * DAY;
    v[i] = 50 + 10 * Math.sin(i / 7);
  }
  return { id, t, v, label: 'price', unit: 'usd' };
}

describe('the view transform', () => {
  it('round-trips time through x', () => {
    const v = view();
    for (const t of [T0, T0 + 37 * DAY, T0 + 100 * DAY]) {
      expect(xToTime(v, timeToX(v, t))).toBeCloseTo(t, 3);
    }
  });

  it('flips the value axis, because y grows downward on screen', () => {
    const v = view();
    expect(valueToY(v, 0)).toBe(400);
    expect(valueToY(v, 100)).toBe(0);
    expect(valueToY(v, 50)).toBe(200);
  });

  it('does not divide by a zero span', () => {
    const flat = view({ t1: T0, v1: 0 });
    expect(Number.isFinite(timeToX(flat, T0))).toBe(true);
    expect(Number.isFinite(valueToY(flat, 0))).toBe(true);
  });
});

describe('the lookup', () => {
  const series = daily(100);

  it('finds the last point at or before a time', () => {
    expect(lastAtOrBefore(series, T0)).toBe(0);
    expect(lastAtOrBefore(series, T0 + 42 * DAY)).toBe(42);
    // Between points: the one before, not the nearer one.
    expect(lastAtOrBefore(series, T0 + 42 * DAY + DAY / 2)).toBe(42);
    expect(lastAtOrBefore(series, T0 + 10_000 * DAY)).toBe(99);
  });

  it('reports -1 when the time precedes the series', () => {
    expect(lastAtOrBefore(series, T0 - 1)).toBe(-1);
    expect(lastAtOrBefore({ id: 'e', t: [], v: [] }, T0)).toBe(-1);
  });

  // Comparison happens in pixels. Under the affine map this view uses that is
  // the same answer as comparing timestamps, and the first version of this
  // test asserted a difference between them that cannot exist — so what is
  // pinned here is the behaviour itself: the midpoint, and which side of it
  // goes where.
  it('picks the nearer of the two bracketing points, breaking ties forward', () => {
    // Two points: x = 0 and x = 750, so the midpoint is x = 375.
    const sparse: Series = { id: 's', t: [T0, T0 + 75 * DAY], v: [1, 2] };
    const v = view();
    expect(nearestIndex(sparse, v, 374)).toBe(0);
    expect(nearestIndex(sparse, v, 376)).toBe(1);
    // Exactly equidistant keeps the earlier point rather than jumping ahead,
    // so a pointer resting on the midpoint does not flicker between the two.
    expect(nearestIndex(sparse, v, 375)).toBe(0);
  });

  it('clamps to the ends rather than reporting nothing', () => {
    const v = view();
    expect(nearestIndex(series, v, -500)).toBe(0);
    expect(nearestIndex(series, v, 99_999)).toBe(99);
    expect(nearestIndex({ id: 'e', t: [], v: [] }, v, 100)).toBe(-1);
  });
});

describe('the crosshair', () => {
  const price = daily(100, 'px');
  // A quarterly fundamental: four points across the same window.
  const quarterly: Series = {
    id: 'gm',
    t: [T0, T0 + 30 * DAY, T0 + 60 * DAY, T0 + 90 * DAY],
    v: [0.62, 0.61, 0.58, 0.59],
    label: 'gross margin',
    unit: 'ratio',
  };

  // The rule that matters: a chart that interpolated would put a gross margin
  // on a Tuesday in February that the company never reported.
  it('reads the last observation at or before the cursor, never an interpolation', () => {
    const at = crosshairAt([quarterly], view(), timeToX(view(), T0 + 45 * DAY));
    const readout = at.readouts[0]!;
    expect(readout.index).toBe(1);
    expect(readout.v).toBe(0.61);
    expect(readout.t).toBe(T0 + 30 * DAY);
  });

  it('gives every series a readout, including the ones with nothing there yet', () => {
    const late: Series = { id: 'late', t: [T0 + 80 * DAY], v: [7] };
    const at = crosshairAt([price, quarterly, late], view(), timeToX(view(), T0 + 10 * DAY));
    expect(at.readouts.map((r) => r.seriesId)).toEqual(['px', 'gm', 'late']);

    const missing = at.readouts.find((r) => r.seriesId === 'late')!;
    expect(missing.index).toBe(-1);
    expect(missing.v).toBeUndefined();
    // Absent, not zero, and not dropped: a chart that silently dropped it from
    // the tooltip would look like the series had ended.
    expect(missing.label).toBe('late');
  });

  it('marks a reading that is older than the cursor', () => {
    const v = view();
    const at = crosshairAt([quarterly], v, timeToX(v, T0 + 59 * DAY), { staleAfterMs: 7 * DAY });
    expect(at.readouts[0]?.stale).toBe(true);

    const fresh = crosshairAt([quarterly], v, timeToX(v, T0 + 31 * DAY), { staleAfterMs: 7 * DAY });
    expect(fresh.readouts[0]?.stale).toBeUndefined();
  });

  it('carries screen coordinates so the marker can be drawn', () => {
    const v = view();
    const at = crosshairAt([price], v, 500);
    const readout = at.readouts[0]!;
    expect(readout.x).toBeCloseTo(timeToX(v, readout.t as number), 9);
    expect(readout.y).toBeCloseTo(valueToY(v, readout.v as number), 9);
  });

  // Snapping to the daily series would make the quarterly readout jump for
  // reasons the analyst cannot see.
  it('snaps only when asked, and only to the series named', () => {
    const v = view();
    const free = crosshairAt([price, quarterly], v, 503.7);
    expect(free.x).toBe(503.7);

    const snapped = crosshairAt([price, quarterly], v, 503.7, { snapTo: 'px' });
    expect(snapped.x).not.toBe(503.7);
    expect(snapped.x).toBeCloseTo(timeToX(v, price.t[nearestIndex(price, v, 503.7)] as number), 9);
  });

  it('clamps a pointer outside the plot to its edges', () => {
    const v = view();
    expect(crosshairAt([price], v, -40).x).toBe(v.plot.minX);
    expect(crosshairAt([price], v, 4000).x).toBe(v.plot.maxX);
  });

  it('ignores a snap target that is not on the chart', () => {
    const v = view();
    expect(crosshairAt([price], v, 321, { snapTo: 'ghost' }).x).toBe(321);
  });
});

describe('range select', () => {
  const price = daily(100);

  it('normalizes a backwards drag to the same range', () => {
    const v = view();
    const forward = rangeFromDrag([price], v, 200, 600)!;
    const backward = rangeFromDrag([price], v, 600, 200)!;
    expect(backward.t0).toBe(forward.t0);
    expect(backward.t1).toBe(forward.t1);
    expect(backward.spans).toEqual(forward.spans);
  });

  it('rejects a click, which is a drag of no width', () => {
    const v = view();
    expect(rangeFromDrag([price], v, 400, 400)).toBeUndefined();
    expect(rangeFromDrag([price], v, 400, 400 + MIN_DRAG_PX - 1)).toBeUndefined();
    expect(rangeFromDrag([price], v, 400, 400 + MIN_DRAG_PX)).toBeDefined();
  });

  // Half-open, so two adjacent selections do not both contain the point on
  // their shared boundary.
  it('is half-open in time', () => {
    const v = view();
    // Exactly days 10 through 20.
    const range = rangeFromDrag([price], v, timeToX(v, T0 + 10 * DAY), timeToX(v, T0 + 20 * DAY))!;
    const span = range.spans[0]!;
    expect(span.from).toBe(10);
    expect(span.to).toBe(19);
    expect(span.count).toBe(10);

    const next = rangeFromDrag([price], v, timeToX(v, T0 + 20 * DAY), timeToX(v, T0 + 30 * DAY))!;
    expect(next.spans[0]?.from).toBe(20);
  });

  it('reports an empty span for a series with nothing in the window', () => {
    const v = view();
    const late: Series = { id: 'late', t: [T0 + 80 * DAY], v: [1] };
    const range = rangeFromDrag([price, late], v, timeToX(v, T0 + 10 * DAY), timeToX(v, T0 + 20 * DAY))!;
    const span = range.spans.find((s) => s.seriesId === 'late')!;
    expect(span.count).toBe(0);
  });

  it('clamps a drag that started or ended outside the plot', () => {
    const v = view();
    const range = rangeFromDrag([price], v, -200, 5000)!;
    expect(range.x0).toBe(v.plot.minX);
    expect(range.x1).toBe(v.plot.maxX);
  });
});

describe('decimation', () => {
  const v = view();

  it('returns every point when the series already fits', () => {
    const small = daily(50);
    expect(decimate(small, v).length).toBe(50);
  });

  it('reduces a long series to about two points per pixel column', () => {
    const long = daily(200_000);
    const wide = view({ t1: T0 + 200_000 * DAY });
    const out = decimate(long, wide);
    const columns = wide.plot.maxX - wide.plot.minX;
    expect(out.length).toBeLessThanOrEqual(columns * 2);
    expect(out.length).toBeGreaterThan(columns);
  });

  // The whole reason this is min/max rather than LTTB: on a price series the
  // extreme *is* the shape, and a decimation that smoothed a spike away would
  // have removed the reason to draw the chart.
  it('keeps a one-point spike that a shape-preserving decimation would drop', () => {
    const n = 100_000;
    const t = new Float64Array(n);
    const value = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      t[i] = T0 + i * 60_000;
      value[i] = 50;
    }
    const spikeAt = 61_234;
    value[spikeAt] = 9_999;
    const series: Series = { id: 'spiky', t, v: value };
    const wide = view({ t1: T0 + n * 60_000, v1: 10_000 });

    const out = decimate(series, wide);
    expect(out.length).toBeLessThan(n / 10);
    expect(out.some((p) => p.index === spikeAt && p.v === 9_999)).toBe(true);
  });

  it('emits each column in time order, so the polyline does not double back', () => {
    const n = 50_000;
    const t = new Float64Array(n);
    const value = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      t[i] = T0 + i * 60_000;
      value[i] = Math.sin(i / 3) * 40 + 50;
    }
    const out = decimate({ id: 's', t, v: value }, view({ t1: T0 + n * 60_000 }));
    for (let i = 1; i < out.length; i += 1) {
      expect((out[i] as { t: number }).t).toBeGreaterThanOrEqual((out[i - 1] as { t: number }).t);
    }
  });

  // The index is what lets a crosshair on a drawn point be exact rather than
  // approximate: the decimated point knows where it came from.
  it('carries the source index of every point it kept', () => {
    const long = daily(100_000);
    const out = decimate(long, view({ t1: T0 + 100_000 * DAY }));
    for (const point of out) {
      expect(long.t[point.index]).toBe(point.t);
      expect(long.v[point.index]).toBe(point.v);
    }
  });

  it('returns nothing for a window entirely before the series', () => {
    const series = daily(100);
    expect(decimate(series, view({ t0: T0 - 500 * DAY, t1: T0 - 400 * DAY }))).toEqual([]);
    expect(decimate({ id: 'e', t: [], v: [] }, v)).toEqual([]);
  });
});

/**
 * PRD 7.1: chart interaction, 12ms p50 / 30ms p95 / 60ms ceiling.
 *
 * Sized at five million points, which is what the PRD sizes a local query at
 * and therefore what a chart can be asked to draw. That number is the whole
 * reason this file is written the way it is: the implementation that reads
 * naturally — walk the points, find the closest — is three orders of magnitude
 * off the budget before anything is drawn.
 */
describe('what a pointer move costs at five million points', () => {
  const N = 5_000_000;
  const minute = 60_000;

  function huge(): Series {
    const t = new Float64Array(N);
    const v = new Float64Array(N);
    for (let i = 0; i < N; i += 1) {
      t[i] = T0 + i * minute;
      v[i] = 50 + 10 * Math.sin(i / 5000) + (i % 997 === 0 ? 5 : 0);
    }
    return { id: 'tick', t, v, label: 'last', unit: 'usd' };
  }

  const series = huge();
  const wide = view({ t1: T0 + N * minute, plot: { minX: 0, minY: 0, maxX: 1400, maxY: 600 } });

  function percentile(sorted: readonly number[], q: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number;
  }

  it('resolves a crosshair well inside the 12ms budget', () => {
    const costs: number[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const x = (i * 37) % 1400;
      const t0 = performance.now();
      crosshairAt([series], wide, x, { snapTo: 'tick' });
      costs.push(performance.now() - t0);
    }
    costs.sort((a, b) => a - b);
    // Binary search: 23 comparisons on five million points rather than five
    // million. Asserted at the PRD's budget, which leaves three orders of
    // magnitude of room — a linear scan here measures in tens of milliseconds
    // and would fail immediately.
    console.log(`  crosshair @5M: p50 ${percentile(costs,0.5).toFixed(4)}ms p95 ${percentile(costs,0.95).toFixed(4)}ms max ${(costs[costs.length-1] as number).toFixed(3)}ms`);
    expect(percentile(costs, 0.5)).toBeLessThan(12);
    expect(percentile(costs, 0.95)).toBeLessThan(30);
    expect(costs[costs.length - 1] as number).toBeLessThan(60);
  });

  it('resolves a range select inside the same budget', () => {
    const costs: number[] = [];
    for (let i = 0; i < 2000; i += 1) {
      const from = (i * 13) % 1200;
      const t0 = performance.now();
      rangeFromDrag([series], wide, from, from + 180);
      costs.push(performance.now() - t0);
    }
    costs.sort((a, b) => a - b);
    expect(percentile(costs, 0.5)).toBeLessThan(12);
    expect(percentile(costs, 0.95)).toBeLessThan(30);
  });

  // Decimation is not a pointer-move cost — it runs when the window changes,
  // not on every mouse position — so it is held to the 60ms ceiling rather
  // than the 12ms p50. What matters is that it is bounded by the pixel width
  // and not by the series length.
  it('decimates five million points to the pixel width, inside the ceiling', () => {
    const t0 = performance.now();
    const out = decimate(series, wide);
    const elapsed = performance.now() - t0;

    const columns = wide.plot.maxX - wide.plot.minX;
    console.log(`  decimate 5M -> ${out.length} points in ${elapsed.toFixed(1)}ms`);
    expect(out.length).toBeLessThanOrEqual(columns * 2);
    expect(elapsed).toBeLessThan(60);
  });

  it('costs the same whether the pointer is at the start or the end', () => {
    const at = (x: number) => {
      const costs: number[] = [];
      for (let i = 0; i < 500; i += 1) {
        const t0 = performance.now();
        crosshairAt([series], wide, x);
        costs.push(performance.now() - t0);
      }
      costs.sort((a, b) => a - b);
      return costs[250] as number;
    };
    // A scan would be free at the left edge and maximal at the right. A binary
    // search is flat, and that is the property the budget rests on.
    const left = at(2);
    const right = at(1398);
    console.log(`  crosshair at left ${left.toFixed(5)}ms  at right ${right.toFixed(5)}ms`);
    expect(right).toBeLessThan(Math.max(left, 0.002) * 8);
  });
});
