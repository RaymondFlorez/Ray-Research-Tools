/**
 * Stroke capture (PRD 3.7).
 *
 * "Pointer events captured with `getCoalescedEvents()` for full stylus sample
 * rate, pressure and tilt retained. Strokes stored as a Yjs `Y.Array` of point
 * runs (append-only, conflict-free)."
 *
 * The run is the unit of that append: one pointer event delivers a batch of
 * coalesced samples, and that batch is appended once. Nothing here ever mutates
 * or reorders an existing run, which is what makes ink the CRDT-friendliest
 * content on the canvas — two people drawing at once can never conflict,
 * because neither is editing what the other wrote.
 */

import type { NodeID, Rect, Vec2 } from '@picasso/canvas-core';
import { bounds, simplify } from './geometry.js';

export interface InkPoint extends Vec2 {
  /** 0 to 1. Mouse input reports 0.5; a stylus reports the real thing. */
  pressure: number;
  /** Milliseconds, from the event timeline. */
  t: number;
  /** Radians from vertical, when the device reports tilt. */
  tilt?: number;
}

/** One append: the coalesced samples from a single pointer event. */
export interface PointRun {
  points: InkPoint[];
}

export interface InkStroke {
  id: string;
  /** Append-only. Never reordered, never edited in place. */
  runs: PointRun[];
  /** Set once the pen lifts. */
  committed?: boolean;
  /** Stroke colour and nominal width, resolved by the renderer. */
  color?: string;
  width?: number;
}

export function strokePoints(stroke: InkStroke): InkPoint[] {
  const out: InkPoint[] = [];
  for (const run of stroke.runs) out.push(...run.points);
  return out;
}

export function strokeBounds(stroke: InkStroke): Rect {
  return bounds(strokePoints(stroke));
}

export function strokeStart(stroke: InkStroke): InkPoint | undefined {
  return stroke.runs[0]?.points[0];
}

export function strokeEnd(stroke: InkStroke): InkPoint | undefined {
  const lastRun = stroke.runs[stroke.runs.length - 1];
  return lastRun?.points[lastRun.points.length - 1];
}

/**
 * Builds a stroke from pointer events. `append` takes the coalesced batch,
 * which on a 240Hz stylus at 60Hz frames is four samples per event; taking only
 * the event's own coordinates would throw three quarters of the ink away.
 */
export class StrokeBuilder {
  private stroke: InkStroke;

  constructor(id: string, options: { color?: string; width?: number } = {}) {
    this.stroke = { id, runs: [] };
    if (options.color !== undefined) this.stroke.color = options.color;
    if (options.width !== undefined) this.stroke.width = options.width;
  }

  /** Appends one run. Empty batches are dropped rather than stored. */
  append(points: readonly InkPoint[]): void {
    if (points.length === 0) return;
    this.stroke.runs.push({ points: points.map((p) => ({ ...p })) });
  }

  get current(): InkStroke {
    return this.stroke;
  }

  get pointCount(): number {
    return this.stroke.runs.reduce((sum, run) => sum + run.points.length, 0);
  }

  /**
   * Pen lift. Simplifies the accumulated points into a single committed run:
   * a 240Hz capture carries far more samples than the shape does, and every one
   * of them is a CRDT entry that syncs and persists forever.
   *
   * Simplification happens only at commit, never mid-stroke, because rewriting
   * points already appended is exactly the mutation the append-only model
   * exists to avoid.
   */
  commit(tolerance = 0.6): InkStroke {
    const points = strokePoints(this.stroke);
    this.stroke = {
      ...this.stroke,
      runs: points.length > 0 ? [{ points: simplify(points, tolerance) }] : [],
      committed: true,
    };
    return this.stroke;
  }
}

/** Nominal to drawn width, for the pressure-varying SDF stroke shader. */
export function pressureWidth(pressure: number, nominal = 3, floor = 0.35): number {
  const clamped = Math.min(1, Math.max(0, pressure));
  return nominal * (floor + (1 - floor) * clamped);
}

/**
 * Appendix C.1: "Recognition fires 300ms after pen lift on a completed stroke
 * group, by which point the analyst is already writing the next thing."
 */
export const RECOGNITION_DELAY_MS = 300;

/** Strokes this far apart in time start a new group. */
export const GROUP_GAP_MS = 900;

/** Strokes this far apart, relative to their size, start a new group. */
export const GROUP_PROXIMITY = 0.6;

export interface StrokeGroup {
  strokes: InkStroke[];
  box: Rect;
  /** Time of the last pen lift in the group. */
  lastLiftAt: number;
}

function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.minX - b.maxX, b.minX - a.maxX));
  const dy = Math.max(0, Math.max(a.minY - b.maxY, b.minY - a.maxY));
  return Math.hypot(dx, dy);
}

function unionRect(a: Rect, b: Rect): Rect {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * Groups strokes that plausibly form one shape: drawn close together in time
 * and overlapping in space. A rectangle drawn as four separate strokes is the
 * case this exists for.
 */
export function groupStrokes(
  strokes: readonly InkStroke[],
  options: { gapMs?: number; proximity?: number } = {},
): StrokeGroup[] {
  const { gapMs = GROUP_GAP_MS, proximity = GROUP_PROXIMITY } = options;
  const ordered = [...strokes]
    .map((stroke) => ({
      stroke,
      box: strokeBounds(stroke),
      start: strokeStart(stroke)?.t ?? 0,
      end: strokeEnd(stroke)?.t ?? 0,
    }))
    .sort((a, b) => a.end - b.end);

  const groups: StrokeGroup[] = [];
  for (const entry of ordered) {
    const open = groups[groups.length - 1];
    if (open) {
      const size = Math.max(
        1e-9,
        Math.hypot(open.box.maxX - open.box.minX, open.box.maxY - open.box.minY),
      );
      // The gap is pen-up to pen-down: how long the hand hesitated, not how
      // long the next stroke took to draw. Measuring to the end of the next
      // stroke breaks a group whenever one of its strokes is slow, which is
      // exactly what a long careful edge of a hand-drawn box is.
      const closeInTime = entry.start - open.lastLiftAt <= gapMs;
      const closeInSpace = rectDistance(open.box, entry.box) / size <= proximity;
      if (closeInTime && closeInSpace) {
        open.strokes.push(entry.stroke);
        open.box = unionRect(open.box, entry.box);
        open.lastLiftAt = entry.end;
        continue;
      }
    }
    groups.push({ strokes: [entry.stroke], box: entry.box, lastLiftAt: entry.end });
  }
  return groups;
}

/**
 * Concatenates a group into one polyline for the shape pass, in the order the
 * strokes were drawn. Where consecutive strokes do not meet, the join is an
 * implicit straight segment, which is what a four-stroke rectangle needs.
 */
export function mergeGroup(group: StrokeGroup): InkPoint[] {
  const ordered = [...group.strokes].sort(
    (a, b) => (strokeEnd(a)?.t ?? 0) - (strokeEnd(b)?.t ?? 0),
  );
  const out: InkPoint[] = [];
  for (const stroke of ordered) out.push(...strokePoints(stroke));
  return out;
}

/**
 * Fires a callback once a group has been idle for the recognition delay.
 * Time is injected rather than read, so the scheduler is testable and so a
 * replayed session recognizes identically to a live one.
 */
export class RecognitionScheduler<T = NodeID> {
  private pending = new Map<T, number>();

  constructor(private readonly delayMs = RECOGNITION_DELAY_MS) {}

  /** Call on pen lift. Restarts the countdown for that group. */
  touch(key: T, now: number): void {
    this.pending.set(key, now);
  }

  cancel(key: T): void {
    this.pending.delete(key);
  }

  /** Returns the groups whose countdown has elapsed, and clears them. */
  due(now: number): T[] {
    const ready: T[] = [];
    for (const [key, at] of this.pending) {
      if (now - at >= this.delayMs) ready.push(key);
    }
    for (const key of ready) this.pending.delete(key);
    return ready;
  }

  get size(): number {
    return this.pending.size;
  }
}
