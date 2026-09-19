import { describe, expect, it } from 'vitest';
import {
  INK_STRIDE,
  InkRibbon,
  ribbonBounds,
  tessellateStroke,
  type RibbonStyle,
} from '../src/ribbon.js';
import { StrokeBuilder, pressureWidth, type InkPoint } from '../src/stroke.js';

const style: RibbonStyle = { rgba: [0.1, 0.1, 0.12, 1], width: 3 };

function point(x: number, y: number, pressure = 0.5, t = 0): InkPoint {
  return { x, y, pressure, t };
}

/** One pointer event's worth of coalesced samples, as a 240Hz stylus delivers. */
function batch(from: number, count: number, t0: number): InkPoint[] {
  const out: InkPoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const k = from + i;
    out.push(point(k * 1.7, 40 + Math.sin(k * 0.13) * 30, 0.4 + 0.3 * Math.sin(k * 0.05), t0 + i * 4.16));
  }
  return out;
}

describe('the ink ribbon', () => {
  it('turns each consecutive pair into one capsule', () => {
    const ribbon = new InkRibbon();
    expect(ribbon.append('s1', [point(0, 0), point(10, 0), point(20, 0)], style)).toBe(3);
    // One degenerate segment for the first sample, then one per pair.
    expect(ribbon.segments).toBe(3);
    expect(ribbon.view().length).toBe(3 * INK_STRIDE);
  });

  it('renders a single tap as a disc rather than nothing', () => {
    const ribbon = new InkRibbon();
    ribbon.append('s1', [point(5, 7, 1)], style);
    const d = ribbon.view();
    expect(ribbon.segments).toBe(1);
    expect([d[0], d[1]]).toEqual([5, 7]);
    expect([d[2], d[3]]).toEqual([5, 7]);
    // Float32, so six places is the honest tolerance, not ten.
    expect(d[4]).toBeCloseTo(pressureWidth(1, 3), 6);
  });

  it('chains across events rather than restarting the stroke', () => {
    const ribbon = new InkRibbon();
    ribbon.append('s1', [point(0, 0), point(10, 0)], style);
    ribbon.append('s1', [point(20, 0)], style);
    expect(ribbon.segments).toBe(3);
    // The third capsule must start where the second ended, or the stroke has a
    // gap at every pointer-event boundary — which on a 60Hz event rate is a gap
    // every four samples.
    const d = ribbon.view();
    const third = 2 * INK_STRIDE;
    expect([d[third], d[third + 1]]).toEqual([10, 0]);
    expect([d[third + 2], d[third + 3]]).toEqual([20, 0]);
  });

  it('keeps two pens apart in one buffer', () => {
    const ribbon = new InkRibbon();
    ribbon.append('maya', [point(0, 0)], style);
    ribbon.append('dev', [point(100, 100)], style);
    ribbon.append('maya', [point(10, 0)], style);
    ribbon.append('dev', [point(110, 100)], style);
    expect(ribbon.open).toBe(2);
    const d = ribbon.view();
    // maya's second segment runs 0,0 -> 10,0; dev's runs 100,100 -> 110,100.
    expect([d[2 * INK_STRIDE], d[2 * INK_STRIDE + 1]]).toEqual([0, 0]);
    expect([d[3 * INK_STRIDE], d[3 * INK_STRIDE + 1]]).toEqual([100, 100]);
  });

  it('carries pressure into both ends of the capsule', () => {
    const ribbon = new InkRibbon();
    ribbon.append('s1', [point(0, 0, 0.2), point(10, 0, 0.9)], style);
    const d = ribbon.view();
    const second = INK_STRIDE;
    expect(d[second + 4]).toBeCloseTo(pressureWidth(0.2, 3), 6);
    expect(d[second + 5]).toBeCloseTo(pressureWidth(0.9, 3), 6);
  });

  it('agrees with the whole-stroke tessellation segment for segment', () => {
    const builder = new StrokeBuilder('s1', { width: 3 });
    const incremental = new InkRibbon(8);
    for (let event = 0; event < 40; event += 1) {
      const samples = batch(event * 4, 4, event * 16.6);
      builder.append(samples);
      incremental.append('s1', samples, style);
    }
    const whole = tessellateStroke(builder.current, style);
    expect(whole.segments).toBe(incremental.segments);
    expect(Array.from(whole.view())).toEqual(Array.from(incremental.view()));
  });

  it('bounds the ink, not the samples', () => {
    const ribbon = new InkRibbon();
    ribbon.append('s1', [point(0, 0, 1), point(10, 0, 1)], style);
    const box = ribbonBounds(ribbon)!;
    const half = pressureWidth(1, 3) / 2;
    expect(box.minX).toBeCloseTo(-half, 6);
    expect(box.maxX).toBeCloseTo(10 + half, 6);
    expect(ribbonBounds(new InkRibbon())).toBeUndefined();
  });

  it('keeps its allocation across a clear', () => {
    const ribbon = new InkRibbon(4);
    ribbon.append('s1', batch(0, 200, 0), style);
    const grown = ribbon.capacity;
    ribbon.clear();
    expect(ribbon.segments).toBe(0);
    expect(ribbon.open).toBe(0);
    expect(ribbon.capacity).toBe(grown);
  });
});

/**
 * The property the 12ms budget rests on.
 *
 * A renderer that re-tessellates the stroke on every pointer event is fine for
 * the first second of drawing and misses the budget by the tenth, and the
 * failure is invisible in a test that draws twenty points. So the measurement
 * is a ratio: what a window of appends costs late in a long stroke against what
 * it cost early. Constant work means a ratio near one; work proportional to
 * stroke length means a ratio near the length ratio.
 */
describe('appending costs the same at the end of a stroke as at the start', () => {
  /**
   * Windows, not events.
   *
   * The first version timed each pointer event and compared means. One append
   * is about two microseconds, which is close enough to `performance.now()`'s
   * resolution that a single scheduler pause on a shared runner moves the mean
   * by a factor of ten — it failed once at 9x with nothing wrong. Timing two
   * hundred events at a time puts each measurement in the hundreds of
   * microseconds, and taking medians across windows drops a pause instead of
   * averaging it in. The regression this is looking for is an order of
   * magnitude and is not remotely subtle once the noise floor is cleared.
   */
  function windowCosts(events: number, per: number): number[] {
    const ribbon = new InkRibbon(events * 4 + 16);
    const costs: number[] = [];
    for (let start = 0; start < events; start += per) {
      const t0 = performance.now();
      for (let event = start; event < start + per; event += 1) {
        ribbon.append('s1', batch(event * 4, 4, event * 16.6), style);
      }
      costs.push(performance.now() - t0);
    }
    return costs;
  }

  function median(xs: readonly number[]): number {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }

  it('does not grow with the stroke', () => {
    // 4,000 events is 16,000 samples: over a minute of unbroken drawing at
    // 240Hz, and forty times the stroke length the early windows see.
    const costs = windowCosts(4_000, 200);
    expect(costs.length).toBe(20);

    // Skip the first window: it is JIT warm-up, not stroke length.
    const early = median(costs.slice(1, 6));
    const late = median(costs.slice(-5));

    // A path that re-tessellates the stroke on every event lands near 30x here.
    // Four is loose enough to survive a busy runner and nowhere near enough to
    // let that through.
    expect(late).toBeLessThan(Math.max(early, 0.05) * 4);
  });

  it('stays inside the per-event share of the 12ms p95 budget', () => {
    // PRD 7.1: ink stroke to screen, 6ms p50 / 12ms p95 / 20ms ceiling. This
    // measures the tessellation only — the pointer event is already in hand and
    // the GPU submit has not happened — so it is a floor on the real number,
    // not the real number. What it can show is that tessellation is not where
    // the budget goes. The end-to-end figure, through a real WebGL context, is
    // `apps/canvas-demo/scripts/inkgl-shots.mjs`.
    const ribbon = new InkRibbon(8192);
    const cost: number[] = [];
    for (let event = 0; event < 1000; event += 1) {
      const samples = batch(event * 4, 4, event * 16.6);
      const t0 = performance.now();
      ribbon.append('s1', samples, style);
      cost.push(performance.now() - t0);
    }
    cost.sort((a, b) => a - b);
    const p95 = cost[Math.min(cost.length - 1, Math.floor(cost.length * 0.95))] as number;
    expect(p95).toBeLessThan(1);
  });
});
