import { describe, expect, it } from 'vitest';
import { niceStep, seriesFigure, seriesSvg, type SeriesPoint } from '../src/series.js';

const box = { width: 600, height: 240 };
const quarters: SeriesPoint[] = [
  { validTime: '2024-03-31', value: 26.04 },
  { validTime: '2024-06-30', value: 30.04 },
  { validTime: '2024-09-30', withheld: 'Requires a vendor-b licence.' },
  { validTime: '2024-12-31', value: 39.33 },
];

describe('drawing a fact series', () => {
  it('places each period by the time scale, computed here without the routine', () => {
    const f = seriesFigure(quarters, box);
    const t = quarters.map((q) => Date.parse(q.validTime));
    const tEnd = t[3]! + (t[3]! - t[0]!) / 3 / 2;
    const expectedX = (ms: number) => 52 + ((ms - t[0]!) / (tEnd - t[0]!)) * (600 - 16 - 52);
    expect(f.markers.map((m) => m.x)).toEqual([expectedX(t[0]!), expectedX(t[1]!), expectedX(t[3]!)]);
    // Higher values sit higher on the page.
    expect(f.markers[2]!.y).toBeLessThan(f.markers[1]!.y);
    expect(f.markers[1]!.y).toBeLessThan(f.markers[0]!.y);
  });

  it('steps: each value runs flat to the next period, never on a slope', () => {
    const f = seriesFigure(quarters, box);
    for (const s of f.segments) {
      for (let i = 1; i < s.length; i += 1) {
        const [x0, y0] = s[i - 1]!;
        const [x1, y1] = s[i]!;
        expect(x0 === x1 || y0 === y1).toBe(true);
      }
    }
  });

  it('breaks the line at a withheld period and marks it with its reason', () => {
    const f = seriesFigure(quarters, box);
    expect(f.segments.length).toBe(2);
    expect(f.markers.map((m) => m.validTime)).toEqual(['2024-03-31', '2024-06-30', '2024-12-31']);
    expect(f.gaps).toEqual([expect.objectContaining({ validTime: '2024-09-30', reason: 'Requires a vendor-b licence.' })]);
    // The run before the gap stops where the withheld period begins.
    const before = f.segments[0]!;
    expect(before[before.length - 1]![0]).toBe(f.gaps[0]!.x0);
    // Nothing is drawn inside the gap.
    for (const s of f.segments) for (const [x] of s) expect(x <= f.gaps[0]!.x0 || x >= f.gaps[0]!.x1).toBe(true);
  });

  it('keeps an honest scale: nice steps, every value inside, every label a value the axis reaches', () => {
    const f = seriesFigure(quarters, box);
    const values = f.yTicks.map((t) => t.value);
    const steps = values.slice(1).map((v, i) => +(v - values[i]!).toFixed(9));
    expect(new Set(steps).size).toBe(1);
    const step = steps[0]!;
    const mantissa = step / 10 ** Math.floor(Math.log10(step));
    expect([1, 2, 5]).toContain(+mantissa.toFixed(9));
    for (const m of f.markers) {
      expect(m.value).toBeGreaterThanOrEqual(f.domain!.v0);
      expect(m.value).toBeLessThanOrEqual(f.domain!.v1);
    }
    expect(values[0]).toBe(f.domain!.v0);
    expect(values[values.length - 1]).toBe(f.domain!.v1);
    expect(f.yTicks.map((t) => t.label)).toEqual(values.map((v) => String(v)));
  });

  it('chooses 1, 2 or 5 times a power of ten', () => {
    expect([niceStep(13.29, 5), niceStep(0.37, 5), niceStep(870, 5), niceStep(1, 5)]).toEqual([5, 0.1, 200, 0.2]);
  });

  it('draws a single period, an all-withheld series and nothing without failing', () => {
    expect(seriesFigure([{ validTime: '2024-06-30', value: 30.04 }], box).markers).toHaveLength(1);
    const blocked = seriesFigure([{ validTime: '2024-06-30', withheld: 'Requires a vendor-b licence.' }], box);
    expect([blocked.segments.length, blocked.gaps.length]).toEqual([0, 1]);
    expect(seriesFigure([], box).domain).toBeUndefined();
  });

  it('writes SVG that escapes what it is given and takes its colors from the page', () => {
    const svg = seriesSvg(seriesFigure([{ validTime: '2024-06-30', withheld: '<script>x</script> & more' }, { validTime: '2024-09-30', value: 1 }], box), 'NVDA "revenue"');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;x&lt;/script&gt; &amp; more');
    expect(svg).toContain('aria-label="NVDA &quot;revenue&quot;"');
    expect(svg).toContain('var(--series-line, currentColor)');
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
