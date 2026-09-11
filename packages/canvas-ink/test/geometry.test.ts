import { describe, expect, it } from 'vitest';
import {
  bounds,
  convexHull,
  detectCorners,
  orientedEllipseResidual,
  pathLength,
  perpendicularDistance,
  polygonArea,
  principalAxes,
  resample,
  simplify,
  smoothPath,
  totalAbsoluteTurning,
} from '../src/geometry.js';

describe('path basics', () => {
  it('measures length and bounds', () => {
    const path = [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 14 }];
    expect(pathLength(path)).toBe(15);
    expect(bounds(path)).toEqual({ minX: 0, minY: 0, maxX: 3, maxY: 14 });
  });

  it('resamples to evenly spaced points along the arc', () => {
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const out = resample(line, 11);
    expect(out).toHaveLength(11);
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[10]?.x).toBeCloseTo(100, 6);
    for (let i = 1; i < out.length; i++) {
      expect((out[i] as { x: number }).x - (out[i - 1] as { x: number }).x).toBeCloseTo(10, 6);
    }
  });

  it('resamples away non-uniform capture speed', () => {
    // Dense at the start, sparse at the end, as a hand slowing into a corner.
    const uneven = [
      { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 },
      { x: 50, y: 0 }, { x: 100, y: 0 },
    ];
    const out = resample(uneven, 6);
    for (let i = 1; i < out.length; i++) {
      expect((out[i] as { x: number }).x - (out[i - 1] as { x: number }).x).toBeCloseTo(20, 6);
    }
  });

  it('degenerate inputs do not throw', () => {
    expect(resample([], 8)).toEqual([]);
    expect(resample([{ x: 1, y: 1 }], 8)).toEqual([{ x: 1, y: 1 }]);
    expect(resample([{ x: 1, y: 1 }, { x: 1, y: 1 }], 4)).toHaveLength(4);
    expect(pathLength([])).toBe(0);
  });
});

describe('simplification', () => {
  it('keeps the endpoints and the shape, drops the redundant middle', () => {
    const line = Array.from({ length: 100 }, (_, i) => ({ x: i, y: 0 }));
    expect(simplify(line, 1)).toEqual([{ x: 0, y: 0 }, { x: 99, y: 0 }]);
  });

  it('keeps a corner that carries the shape', () => {
    const bent = [
      ...Array.from({ length: 20 }, (_, i) => ({ x: i * 5, y: 0 })),
      ...Array.from({ length: 20 }, (_, i) => ({ x: 95, y: i * 5 })),
    ];
    const out = simplify(bent, 1);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out.length).toBeLessThan(8);
    expect(out[0]).toEqual({ x: 0, y: 0 });
  });

  it('preserves whatever extra fields a point carries', () => {
    const points = Array.from({ length: 40 }, (_, i) => ({ x: i, y: 0, pressure: 0.5, t: i }));
    const out = simplify(points, 1);
    expect(out[0]?.pressure).toBe(0.5);
    expect(out[out.length - 1]?.t).toBe(39);
  });

  it('measures perpendicular distance including past the segment ends', () => {
    expect(perpendicularDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 9);
    expect(perpendicularDistance({ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(4, 9);
  });
});

describe('curvature', () => {
  it('smoothing pins the endpoints', () => {
    const path = [{ x: 0, y: 0 }, { x: 5, y: 9 }, { x: 10, y: 0 }, { x: 15, y: 9 }];
    const out = smoothPath(path);
    expect(out[0]).toEqual(path[0]);
    expect(out[out.length - 1]).toEqual(path[path.length - 1]);
  });

  it('smoothing strips tremor energy but leaves the real corner', () => {
    // A right angle drawn with a shaky hand: alternating samples off the line.
    const corner = [
      ...Array.from({ length: 30 }, (_, i) => ({ x: i * 3, y: (i % 2) * 2.5 })),
      ...Array.from({ length: 30 }, (_, i) => ({ x: 87 + (i % 2) * 2.5, y: i * 3 })),
    ];
    const raw = resample(corner, 64);
    const smoothed = smoothPath(raw);

    // The tremor contributes turning that the shape does not.
    expect(totalAbsoluteTurning(raw)).toBeGreaterThan(totalAbsoluteTurning(smoothed) * 2);
    // One corner was drawn, so one corner is found.
    expect(detectCorners(smoothed)).toHaveLength(1);
    expect(Math.abs((detectCorners(smoothed)[0] as { angle: number }).angle))
      .toBeGreaterThan(1.2);
  });

  it('reports one corner per corner, not one per turning peak', () => {
    // A square: four corners, whatever the sampling.
    const square = [
      ...Array.from({ length: 25 }, (_, i) => ({ x: i * 4, y: 0 })),
      ...Array.from({ length: 25 }, (_, i) => ({ x: 96, y: i * 4 })),
      ...Array.from({ length: 25 }, (_, i) => ({ x: 96 - i * 4, y: 96 })),
      ...Array.from({ length: 25 }, (_, i) => ({ x: 0, y: 96 - i * 4 })),
    ];
    const corners = detectCorners(smoothPath(resample(square, 64)));
    expect(corners.length).toBeGreaterThanOrEqual(3);
    expect(corners.length).toBeLessThanOrEqual(4);
  });

  it('a closed loop turns through about 2π', () => {
    const steps = 64;
    const circle = Array.from({ length: steps + 1 }, (_, i) => {
      const t = (i / steps) * Math.PI * 2;
      return { x: Math.cos(t) * 50, y: Math.sin(t) * 50 };
    });
    // Turning is defined at interior samples, so a polyline that closes back on
    // its start misses exactly the one turn at the seam.
    const perStep = (Math.PI * 2) / steps;
    expect(totalAbsoluteTurning(circle)).toBeCloseTo(Math.PI * 2 - perStep, 5);
  });
});

describe('hull, area and the oriented frame', () => {
  it('hulls a point cloud and measures its area', () => {
    const cloud = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 5, y: 5 },
    ];
    expect(polygonArea(convexHull(cloud))).toBeCloseTo(100, 6);
  });

  it('finds the principal axes of a tilted ellipse', () => {
    const angle = Math.PI / 5;
    const points = Array.from({ length: 64 }, (_, i) => {
      const t = (i / 64) * Math.PI * 2;
      const x = Math.cos(t) * 100;
      const y = Math.sin(t) * 30;
      return {
        x: x * Math.cos(angle) - y * Math.sin(angle),
        y: x * Math.sin(angle) + y * Math.cos(angle),
      };
    });
    const box = principalAxes(points);
    expect(box.halfU).toBeCloseTo(100, 0);
    expect(box.halfV).toBeCloseTo(30, 0);
    // Fits its own ellipse almost exactly, whatever the tilt.
    expect(orientedEllipseResidual(points, box)).toBeLessThan(0.02);
  });
});
