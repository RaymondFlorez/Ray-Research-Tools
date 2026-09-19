/**
 * Stroke tessellation for the GPU path (PRD 7.1, 7.3).
 *
 * > Ink stroke to screen — 6ms p50, 12ms p95, 20ms hard ceiling. *This is the
 * > one users feel most.*
 *
 * > Stroke rendering — 12ms p95, hard. SDF shader, pure WebGL, no ML. Always
 * > local.
 *
 * Two constraints, and the second one is how the first is met.
 *
 * **One segment is one instance.** A pointer event delivers a batch of
 * coalesced samples; each consecutive pair becomes a rounded capsule, and the
 * capsules overlap. That overlap *is* the join — there are no miters, no bevels
 * and no round-join fans to tessellate, which is the entire reason the PRD
 * specifies an SDF shader rather than a triangulated ribbon. A triangulated
 * ribbon has to solve the join, and solving the join on a stroke that doubles
 * back on itself at 240Hz is where ink renderers spend their frame budget.
 *
 * **Appending is O(1) in the samples appended, not in the stroke's length.**
 * The buffer grows; nothing already written is touched. A 4,000-point stroke
 * costs the same per event as a 40-point one, which is the property the 12ms
 * p95 actually rests on — a path that re-tessellates the whole stroke per event
 * is fine for the first second of drawing and misses the budget by the tenth.
 * `test/ribbon.test.ts` measures that rather than asserting it.
 *
 * The buffer is a flat `Float32Array` in the layout the vertex shader reads, so
 * there is no second pass to pack it. That means this module decides the
 * instance layout and `canvas-gl` follows it, rather than the other way round:
 * the tessellation knows what a stroke is and the renderer knows what a buffer
 * is, and only one of them should have an opinion about ink.
 *
 * What is *not* here: colour parsing, viewport transforms, and anything that
 * needs a GL context. Coordinates go in as the caller's pixels and come out the
 * same, so this file runs and is measured under Node.
 */

import type { Rect } from '@picasso/canvas-core';
import type { InkPoint, InkStroke } from './stroke.js';
import { pressureWidth, strokePoints } from './stroke.js';

/** Floats per segment instance: x0, y0, x1, y1, w0, w1, r, g, b, a. */
export const INK_STRIDE = 10;

/** Premultiplication is the renderer's business; this is straight RGBA, 0..1. */
export type RGBA = readonly [number, number, number, number];

export interface RibbonStyle {
  rgba: RGBA;
  /** Nominal width in pixels, before pressure. */
  width: number;
  /** Lower bound on the pressure multiplier. See `pressureWidth`. */
  floor?: number;
}

/**
 * A growing buffer of capsule instances, appended to as the pen moves.
 *
 * Holds many strokes at once on purpose: two analysts drawing on the same
 * canvas, or one hand and one stylus, are two open strokes, and putting them in
 * one buffer keeps ink at one draw call however many pens are down. The last
 * point of each open stroke is remembered by id, so the segments of one stroke
 * chain correctly while another interleaves with it.
 */
export class InkRibbon {
  private data: Float32Array;
  private used = 0;
  private readonly tails = new Map<string, InkPoint>();

  constructor(capacitySegments = 1024) {
    this.data = new Float32Array(Math.max(1, capacitySegments) * INK_STRIDE);
  }

  /** Segments written so far. */
  get segments(): number {
    return this.used / INK_STRIDE;
  }

  /** Capacity in segments, before the next growth. */
  get capacity(): number {
    return this.data.length / INK_STRIDE;
  }

  /** The written prefix, ready to upload. A view, not a copy. */
  view(): Float32Array {
    return this.data.subarray(0, this.used);
  }

  /** How many strokes are mid-flight. */
  get open(): number {
    return this.tails.size;
  }

  /**
   * Append one pointer event's coalesced samples for one stroke.
   *
   * Returns the number of segments written. The first sample of a stroke writes
   * a degenerate segment — a capsule with both ends at the same point, which
   * the shader renders as a disc — so a tap leaves a dot rather than nothing.
   */
  append(strokeId: string, points: readonly InkPoint[], style: RibbonStyle): number {
    if (points.length === 0) return 0;

    const floor = style.floor;
    const widthOf = (p: InkPoint): number =>
      floor === undefined
        ? pressureWidth(p.pressure, style.width)
        : pressureWidth(p.pressure, style.width, floor);

    let previous = this.tails.get(strokeId);
    let written = 0;

    if (previous === undefined) {
      const first = points[0] as InkPoint;
      this.reserve(points.length);
      this.write(first, first, widthOf(first), widthOf(first), style.rgba);
      written += 1;
      previous = first;
    } else {
      this.reserve(points.length);
    }

    for (const point of previous === points[0] ? points.slice(1) : points) {
      this.write(previous, point, widthOf(previous), widthOf(point), style.rgba);
      written += 1;
      previous = point;
    }

    this.tails.set(strokeId, previous);
    return written;
  }

  /** Forget a stroke's tail. The segments already written stay. */
  end(strokeId: string): void {
    this.tails.delete(strokeId);
  }

  /** Drop everything. Keeps the allocation, which is the point of reusing one. */
  clear(): void {
    this.used = 0;
    this.tails.clear();
  }

  private reserve(points: number): void {
    const needed = this.used + (points + 1) * INK_STRIDE;
    if (needed <= this.data.length) return;
    let size = Math.max(this.data.length * 2, INK_STRIDE);
    while (size < needed) size *= 2;
    const grown = new Float32Array(size);
    grown.set(this.data.subarray(0, this.used));
    this.data = grown;
  }

  private write(a: InkPoint, b: InkPoint, w0: number, w1: number, rgba: RGBA): void {
    const i = this.used;
    const d = this.data;
    d[i] = a.x;
    d[i + 1] = a.y;
    d[i + 2] = b.x;
    d[i + 3] = b.y;
    d[i + 4] = w0;
    d[i + 5] = w1;
    d[i + 6] = rgba[0];
    d[i + 7] = rgba[1];
    d[i + 8] = rgba[2];
    d[i + 9] = rgba[3];
    this.used += INK_STRIDE;
  }
}

/**
 * Tessellate a whole stroke in one go.
 *
 * For redrawing committed ink — after `StrokeBuilder.commit` has simplified it,
 * after a reload, or when a peer's stroke arrives complete. The live path is
 * `InkRibbon.append`; this is the same tessellation without the incremental
 * bookkeeping, and the two agree segment for segment, which `test/ribbon.test.ts`
 * asserts rather than trusting.
 */
export function tessellateStroke(
  stroke: InkStroke,
  style: RibbonStyle,
  into?: InkRibbon,
): InkRibbon {
  const ribbon = into ?? new InkRibbon(Math.max(16, countPoints(stroke) + 1));
  const points = strokePoints(stroke);
  if (points.length > 0) ribbon.append(stroke.id, points, style);
  ribbon.end(stroke.id);
  return ribbon;
}

function countPoints(stroke: InkStroke): number {
  let n = 0;
  for (const run of stroke.runs) n += run.points.length;
  return n;
}

/**
 * The rectangle a tessellated buffer covers, half-widths included.
 *
 * The stroke's point bounds are not the ink's bounds: a 3px nib puts ink a pixel
 * and a half outside the outermost sample, and a damage rect computed from the
 * points alone leaves a rim of stale pixels behind a moving pen.
 */
export function ribbonBounds(ribbon: InkRibbon): Rect | undefined {
  const data = ribbon.view();
  if (data.length === 0) return undefined;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < data.length; i += INK_STRIDE) {
    const x0 = data[i] as number;
    const y0 = data[i + 1] as number;
    const x1 = data[i + 2] as number;
    const y1 = data[i + 3] as number;
    const r0 = (data[i + 4] as number) * 0.5;
    const r1 = (data[i + 5] as number) * 0.5;
    minX = Math.min(minX, x0 - r0, x1 - r1);
    minY = Math.min(minY, y0 - r0, y1 - r1);
    maxX = Math.max(maxX, x0 + r0, x1 + r1);
    maxY = Math.max(maxY, y0 + r0, y1 + r1);
  }
  return { minX, minY, maxX, maxY };
}
