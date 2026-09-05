/**
 * Viewport transform, semantic zoom and level of detail (PRD 3.1, 3.8).
 *
 * World space is float64 on an unbounded plane. The viewport is an affine
 * transform (translate, uniform scale), so pan and zoom touch no node data:
 * only the transform changes.
 */

import type { Vec2 } from './types.js';

/** Zoom is clamped to [2^-12, 2^6]. */
export const ZOOM_MIN = 2 ** -12;
export const ZOOM_MAX = 2 ** 6;

/** Pan momentum friction, applied per frame. */
export const PAN_FRICTION = 0.92;

/** DOM mount/unmount on an LOD crossing is debounced to stop scroll thrash. */
export const LOD_DEBOUNCE_MS = 120;

/** The renderer culls to `viewport ∪ margin(1.5 screens)`. */
export const CULL_MARGIN_SCREENS = 1.5;

export interface Viewport {
  /** World-space coordinate rendered at the top-left of the surface. */
  x: number;
  y: number;
  /** Uniform scale: screen pixels per world unit. */
  scale: number;
  /** Surface size in screen pixels. */
  width: number;
  height: number;
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type LOD = 0 | 1 | 2 | 3;

/**
 * PRD 3.1. Zoom maps to level of detail, not just to scale.
 *   < 0.15         LOD0  instanced quads, no DOM
 *   0.15 to 0.45   LOD1  canvas tile with title, metric, sparkline
 *   0.45 to 2.0    LOD2  full interactive node, React DOM mounts
 *   > 2.0          LOD3  detail view
 */
export function lodForScale(scale: number): LOD {
  if (scale < 0.15) return 0;
  if (scale < 0.45) return 1;
  if (scale <= 2.0) return 2;
  return 3;
}

export function clampZoom(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

export function worldToScreen(vp: Viewport, world: Vec2): Vec2 {
  return { x: (world.x - vp.x) * vp.scale, y: (world.y - vp.y) * vp.scale };
}

export function screenToWorld(vp: Viewport, screen: Vec2): Vec2 {
  return { x: screen.x / vp.scale + vp.x, y: screen.y / vp.scale + vp.y };
}

/** Pan by a screen-space delta. */
export function panBy(vp: Viewport, dxScreen: number, dyScreen: number): Viewport {
  return { ...vp, x: vp.x - dxScreen / vp.scale, y: vp.y - dyScreen / vp.scale };
}

/**
 * Cursor-anchored zoom: the world point under the cursor stays under the
 * cursor. Scroll, pinch and `Cmd +/-` all route through here.
 */
export function zoomAt(vp: Viewport, anchorScreen: Vec2, factor: number): Viewport {
  const nextScale = clampZoom(vp.scale * factor);
  if (nextScale === vp.scale) return vp;
  const anchorWorld = screenToWorld(vp, anchorScreen);
  return {
    ...vp,
    scale: nextScale,
    x: anchorWorld.x - anchorScreen.x / nextScale,
    y: anchorWorld.y - anchorScreen.y / nextScale,
  };
}

/** The world rectangle currently on screen. */
export function visibleWorldRect(vp: Viewport): Rect {
  return {
    minX: vp.x,
    minY: vp.y,
    maxX: vp.x + vp.width / vp.scale,
    maxY: vp.y + vp.height / vp.scale,
  };
}

/** The visible rect grown by the cull margin, in world units. */
export function cullRect(vp: Viewport, marginScreens = CULL_MARGIN_SCREENS): Rect {
  const r = visibleWorldRect(vp);
  const mx = ((r.maxX - r.minX) * marginScreens) / 2;
  const my = ((r.maxY - r.minY) * marginScreens) / 2;
  return { minX: r.minX - mx, minY: r.minY - my, maxX: r.maxX + mx, maxY: r.maxY + my };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxY - r.minY);
}

export function unionRect(a: Rect, b: Rect): Rect {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Extra area required to grow `a` to also cover `b`. Drives R-tree insertion. */
export function enlargement(a: Rect, b: Rect): number {
  return rectArea(unionRect(a, b)) - rectArea(a);
}

/**
 * Debounces LOD crossings so a scroll-wheel zoom does not mount and unmount DOM
 * on every frame. The committed LOD only follows the raw LOD once the raw value
 * has held still for `LOD_DEBOUNCE_MS`.
 */
export class LodTracker {
  private committed: LOD;
  private pending: LOD;
  private pendingSince: number;

  constructor(initialScale: number, now = 0) {
    this.committed = lodForScale(initialScale);
    this.pending = this.committed;
    this.pendingSince = now;
  }

  /** Feeds a new scale and returns the LOD the renderer should honour. */
  update(scale: number, now: number, debounceMs = LOD_DEBOUNCE_MS): LOD {
    const raw = lodForScale(scale);
    if (raw !== this.pending) {
      this.pending = raw;
      this.pendingSince = now;
      return this.committed;
    }
    if (raw !== this.committed && now - this.pendingSince >= debounceMs) {
      this.committed = raw;
    }
    return this.committed;
  }

  get value(): LOD {
    return this.committed;
  }
}

/** Pan momentum with 0.92 friction. Returns null once the glide is spent. */
export function stepMomentum(
  velocity: Vec2,
  friction = PAN_FRICTION,
  minSpeed = 0.05,
): Vec2 | null {
  const next = { x: velocity.x * friction, y: velocity.y * friction };
  if (Math.abs(next.x) < minSpeed && Math.abs(next.y) < minSpeed) return null;
  return next;
}
