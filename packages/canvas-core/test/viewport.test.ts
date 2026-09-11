import { describe, expect, it } from 'vitest';
import {
  LOD_DEBOUNCE_MS,
  LodTracker,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  cullRect,
  lodForScale,
  panBy,
  screenToWorld,
  stepMomentum,
  visibleWorldRect,
  worldToScreen,
  zoomAt,
  type Viewport,
} from '../src/viewport.js';

const vp = (over: Partial<Viewport> = {}): Viewport => ({
  x: 0,
  y: 0,
  scale: 1,
  width: 1000,
  height: 800,
  ...over,
});

describe('viewport transform (PRD 3.1)', () => {
  it('round-trips world and screen coordinates', () => {
    const v = vp({ x: 120.5, y: -40.25, scale: 0.37 });
    const world = { x: 933.125, y: 12.5 };
    const back = screenToWorld(v, worldToScreen(v, world));
    expect(back.x).toBeCloseTo(world.x, 9);
    expect(back.y).toBeCloseTo(world.y, 9);
  });

  it('clamps zoom to [2^-12, 2^6]', () => {
    expect(clampZoom(1e-9)).toBe(ZOOM_MIN);
    expect(clampZoom(1e9)).toBe(ZOOM_MAX);
    expect(ZOOM_MIN).toBeCloseTo(0.000244140625, 12);
    expect(ZOOM_MAX).toBe(64);
  });

  it('anchors zoom at the cursor', () => {
    const v = vp({ x: 10, y: 20, scale: 1 });
    const anchor = { x: 400, y: 300 };
    const before = screenToWorld(v, anchor);
    const zoomed = zoomAt(v, anchor, 2.5);
    const after = screenToWorld(zoomed, anchor);
    expect(zoomed.scale).toBe(2.5);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('does not move the viewport when zoom is already clamped', () => {
    const v = vp({ scale: ZOOM_MAX });
    expect(zoomAt(v, { x: 10, y: 10 }, 2)).toBe(v);
  });

  it('pans in world units scaled by zoom', () => {
    const v = vp({ scale: 2 });
    const panned = panBy(v, 100, 50);
    expect(panned.x).toBe(-50);
    expect(panned.y).toBe(-25);
  });

  it('computes the visible rect and a 1.5-screen cull margin', () => {
    const v = vp({ x: 0, y: 0, scale: 1, width: 1000, height: 800 });
    expect(visibleWorldRect(v)).toEqual({ minX: 0, minY: 0, maxX: 1000, maxY: 800 });
    // 1.5 screens of margin, split evenly on both sides.
    expect(cullRect(v)).toEqual({ minX: -750, minY: -600, maxX: 1750, maxY: 1400 });
  });

  it('decays pan momentum with 0.92 friction and stops', () => {
    let velocity: { x: number; y: number } | null = { x: 40, y: 0 };
    let frames = 0;
    while (velocity && frames < 1000) {
      velocity = stepMomentum(velocity);
      frames += 1;
    }
    expect(velocity).toBeNull();
    expect(frames).toBeGreaterThan(5);
    expect(frames).toBeLessThan(200);
  });
});

describe('semantic zoom (PRD 3.1)', () => {
  it('maps scale to the four levels of detail', () => {
    expect(lodForScale(0.05)).toBe(0);
    expect(lodForScale(0.149)).toBe(0);
    expect(lodForScale(0.15)).toBe(1);
    expect(lodForScale(0.44)).toBe(1);
    expect(lodForScale(0.45)).toBe(2);
    expect(lodForScale(2.0)).toBe(2);
    expect(lodForScale(2.01)).toBe(3);
  });

  it('debounces LOD crossings by 120ms so a wheel zoom does not thrash the DOM', () => {
    const tracker = new LodTracker(1.0, 0);
    expect(tracker.value).toBe(2);

    // Cross into LOD1 and keep moving: the committed LOD holds.
    expect(tracker.update(0.4, 10)).toBe(2);
    expect(tracker.update(0.4, 100)).toBe(2);
    // Held still past the debounce window: now it commits.
    expect(tracker.update(0.4, 10 + LOD_DEBOUNCE_MS)).toBe(1);

    // A flick through LOD0 that does not settle never commits.
    expect(tracker.update(0.1, 200)).toBe(1);
    expect(tracker.update(0.4, 260)).toBe(1);
    expect(tracker.update(0.4, 400)).toBe(1);
  });
});
