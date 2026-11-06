/**
 * Drawing a fact series: what a `ChartNode` puts on the canvas (PRD 3.3).
 *
 * canvas-data's `evaluateSeriesChart` decides the points: every period in
 * range, each at the value known at the canvas's time, and a period the reader
 * may not see as an entry with a reason and no value. This turns them into
 * geometry and SVG, and keeps three rules the points carry.
 *
 * **A step, not a slope.** A reported figure holds until the next one is
 * reported; a line drawn between two quarters would show values in between
 * that were never reported, which is the interpolation `chart.ts`'s readout
 * already refuses. Each value runs flat to the next period, then steps.
 *
 * **A withheld period breaks the line.** The step from the period before it
 * stops where it begins, and the period is drawn as a marked band carrying
 * its reason. Nothing is drawn through it, so the line cannot suggest a value
 * that the reader was not shown.
 *
 * **The scale is honest.** Ticks are 1, 2 or 5 times a power of ten, the
 * value axis covers every value drawn, and every tick label names a value
 * inside the drawn range.
 */

export interface SeriesPoint {
  /** ISO date or instant of the period. */
  validTime: string;
  value?: number;
  /** Set when the reader may not see this period: why. */
  withheld?: string;
}

export interface SeriesBox {
  width: number;
  height: number;
  padding?: { left: number; right: number; top: number; bottom: number };
}

export interface SeriesFigure {
  width: number;
  height: number;
  plot: { left: number; right: number; top: number; bottom: number };
  /** Value domain after rounding to ticks, and the time domain in epoch ms. */
  domain: { t0: number; t1: number; v0: number; v1: number } | undefined;
  /** Each unbroken run of the line, as [x, y] vertices. */
  segments: Array<Array<[number, number]>>;
  /** One per value point. */
  markers: Array<{ x: number; y: number; validTime: string; value: number }>;
  /** One per withheld period: the span it occupies and why. */
  gaps: Array<{ x0: number; x1: number; validTime: string; reason: string }>;
  xTicks: Array<{ x: number; label: string }>;
  yTicks: Array<{ y: number; value: number; label: string }>;
}

const DEFAULT_PADDING = { left: 52, right: 16, top: 14, bottom: 30 };
const DAY = 86_400_000;

/** A tick step of 1, 2 or 5 times a power of ten giving at most `count` intervals over `span`. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * power >= raw) return m * power;
  return 10 * power;
}

function label(v: number, step: number): string {
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(Math.min(decimals, 6));
}

export function seriesFigure(points: readonly SeriesPoint[], box: SeriesBox): SeriesFigure {
  const padding = box.padding ?? DEFAULT_PADDING;
  const plot = { left: padding.left, right: box.width - padding.right, top: padding.top, bottom: box.height - padding.bottom };
  const figure: SeriesFigure = { width: box.width, height: box.height, plot, domain: undefined, segments: [], markers: [], gaps: [], xTicks: [], yTicks: [] };
  if (points.length === 0) return figure;

  const times = points.map((p) => Date.parse(p.validTime));
  let t0 = Math.min(...times);
  let t1 = Math.max(...times);
  if (t1 === t0) {
    t0 -= 30 * DAY;
    t1 += 30 * DAY;
  }
  const values = points.filter((p) => p.withheld === undefined && p.value !== undefined).map((p) => p.value!);
  let v0 = values.length ? Math.min(...values) : 0;
  let v1 = values.length ? Math.max(...values) : 1;
  if (v1 === v0) {
    const pad = Math.abs(v0) > 0 ? Math.abs(v0) * 0.1 : 1;
    v0 -= pad;
    v1 += pad;
  }
  const step = niceStep(v1 - v0, 5);
  v0 = Math.floor(v0 / step) * step;
  v1 = Math.ceil(v1 / step) * step;
  figure.domain = { t0, t1, v0, v1 };

  // The last period gets a step's width of room after it, so its value is a visible run.
  const lastRun = times.length > 1 ? (t1 - t0) / (times.length - 1) : 30 * DAY;
  const tEnd = t1 + lastRun * 0.5;
  const x = (t: number) => plot.left + ((t - t0) / (tEnd - t0)) * (plot.right - plot.left);
  const y = (v: number) => plot.bottom - ((v - v0) / (v1 - v0)) * (plot.bottom - plot.top);

  let run: Array<[number, number]> = [];
  points.forEach((p, i) => {
    const xi = x(times[i]!);
    const xNext = i + 1 < points.length ? x(times[i + 1]!) : x(tEnd);
    if (p.withheld !== undefined || p.value === undefined) {
      if (run.length) figure.segments.push(run);
      run = [];
      figure.gaps.push({ x0: xi, x1: xNext, validTime: p.validTime, reason: p.withheld ?? 'no value' });
      return;
    }
    const yi = y(p.value);
    figure.markers.push({ x: xi, y: yi, validTime: p.validTime, value: p.value });
    if (run.length) run.push([xi, run[run.length - 1]![1]]);
    run.push([xi, yi], [xNext, yi]);
  });
  if (run.length) figure.segments.push(run);

  for (let v = v0; v <= v1 + step / 2; v += step) {
    const value = Number(v.toPrecision(12));
    figure.yTicks.push({ y: y(value), value, label: label(value, step) });
  }
  if (points.length <= 8) {
    points.forEach((p, i) => figure.xTicks.push({ x: x(times[i]!), label: p.validTime.slice(0, 10) }));
  } else {
    for (let k = 0; k < 6; k += 1) {
      const t = t0 + ((t1 - t0) * k) / 5;
      figure.xTicks.push({ x: x(t), label: new Date(t).toISOString().slice(0, 10) });
    }
  }
  return figure;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const r = (n: number) => Math.round(n * 10) / 10;

/**
 * The figure as an SVG string. Colors come from the page: `--series-line`,
 * `--series-gap`, `--series-grid` and `--series-text`, each falling back to
 * `currentColor`, so the chart follows the page's theme.
 */
export function seriesSvg(figure: SeriesFigure, title: string): string {
  const { plot } = figure;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${figure.width} ${figure.height}" width="${figure.width}" height="${figure.height}" role="img" aria-label="${escape(title)}">`,
    `<title>${escape(title)}</title>`,
    '<defs><pattern id="series-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--series-gap, currentColor)" stroke-width="2"/></pattern></defs>',
  ];
  for (const t of figure.yTicks) {
    parts.push(`<line class="grid" x1="${plot.left}" x2="${plot.right}" y1="${r(t.y)}" y2="${r(t.y)}" stroke="var(--series-grid, currentColor)" stroke-opacity="0.25" fill="none"/>`);
    parts.push(`<text class="ytick" x="${plot.left - 6}" y="${r(t.y)}" text-anchor="end" dominant-baseline="middle" font-size="11" fill="var(--series-text, currentColor)">${escape(t.label)}</text>`);
  }
  for (const t of figure.xTicks) {
    parts.push(`<text class="xtick" x="${r(t.x)}" y="${plot.bottom + 18}" text-anchor="middle" font-size="11" fill="var(--series-text, currentColor)">${escape(t.label)}</text>`);
  }
  for (const g of figure.gaps) {
    parts.push(`<rect class="gap" x="${r(g.x0)}" y="${plot.top}" width="${r(Math.max(2, g.x1 - g.x0))}" height="${plot.bottom - plot.top}" fill="url(#series-hatch)" fill-opacity="0.35"><title>${escape(`${g.validTime}: ${g.reason}`)}</title></rect>`);
  }
  for (const s of figure.segments) {
    parts.push(`<polyline class="line" points="${s.map(([px, py]) => `${r(px)},${r(py)}`).join(' ')}" fill="none" stroke="var(--series-line, currentColor)" stroke-width="2"/>`);
  }
  for (const m of figure.markers) {
    parts.push(`<circle class="marker" cx="${r(m.x)}" cy="${r(m.y)}" r="3.5" fill="var(--series-line, currentColor)"><title>${escape(`${m.validTime}: ${m.value}`)}</title></circle>`);
  }
  parts.push('</svg>');
  return parts.join('');
}
