import { describe, expect, it } from 'vitest';
import { coarseViewportBbox, decimatePoints, pointBudgetForZoom } from './lod';

function makePoints(n: number): { lng: number; lat: number; mag: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    lng: ((i * 37) % 360) - 180,
    lat: ((i * 17) % 180) - 90,
    mag: i % 10,
  }));
}

describe('decimatePoints', () => {
  it('returns the input unchanged when under the cap', () => {
    expect(decimatePoints(makePoints(50), 100)).toHaveLength(50);
  });

  it('reduces to at most maxPoints', () => {
    const out = decimatePoints(makePoints(5000), 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.length).toBeGreaterThan(0);
  });

  it('keeps the highest-priority point per cell', () => {
    const rows = [
      { lng: 10.1, lat: 10.1, mag: 2 },
      { lng: 10.2, lat: 10.2, mag: 9 },
    ];
    const out = decimatePoints(rows, 1, { priorityField: 'mag' });
    expect(out).toEqual([{ lng: 10.2, lat: 10.2, mag: 9 }]);
  });

  it('is deterministic', () => {
    const rows = makePoints(3000);
    expect(decimatePoints(rows, 100, { priorityField: 'mag' })).toEqual(
      decimatePoints(rows, 100, { priorityField: 'mag' }),
    );
  });
});

describe('pointBudgetForZoom', () => {
  it('grows with zoom and is capped', () => {
    expect(pointBudgetForZoom(0)).toBeLessThan(pointBudgetForZoom(3));
    expect(pointBudgetForZoom(20)).toBe(50_000);
  });
});

describe('coarseViewportBbox', () => {
  it('returns null when zoomed out', () => {
    expect(coarseViewportBbox({ longitude: 0, latitude: 0, zoom: 1 })).toBeNull();
  });

  it('contains the camera center and snaps to 10-degree edges', () => {
    const bbox = coarseViewportBbox({ longitude: 139.7, latitude: 35.7, zoom: 4 })!;
    const [w, s, e, n] = bbox;
    expect(w).toBeLessThan(139.7);
    expect(e).toBeGreaterThan(139.7);
    expect(s).toBeLessThan(35.7);
    expect(n).toBeGreaterThan(35.7);
    for (const v of bbox) expect(v % 10).toBe(0);
  });

  it('is stable under small camera moves (cache-friendly)', () => {
    expect(coarseViewportBbox({ longitude: 139.7, latitude: 35.7, zoom: 4 })).toEqual(
      coarseViewportBbox({ longitude: 140.4, latitude: 36.1, zoom: 4 }),
    );
  });

  it('clamps to world bounds', () => {
    const [, , e, n] = coarseViewportBbox({ longitude: 178, latitude: 88, zoom: 4 })!;
    expect(e).toBeLessThanOrEqual(180);
    expect(n).toBeLessThanOrEqual(90);
  });
});
