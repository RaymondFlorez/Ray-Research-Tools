import { describe, expect, it } from 'vitest';
import {
  contour,
  heatmapCells,
  heatmapPick,
  MAX_ELEVATION,
  MIN_ELEVATION,
  orbit,
  project,
  surfaceColor,
  surfaceMesh,
  surfacePick,
  valueAt,
  worldPoint,
  zDomain,
  type Camera,
  type SurfaceGrid,
  type Triangle,
} from '../src/surface.js';

const rect = { minX: 0, minY: 0, maxX: 600, maxY: 400 };

/** A P&L-shaped surface: a ridge in spot that fades with vol, with losses on both wings. */
function pnl(nx = 25, ny = 15): SurfaceGrid {
  const xs = Array.from({ length: nx }, (_, i) => 75 + (50 * i) / (nx - 1));
  const ys = Array.from({ length: ny }, (_, j) => 0.18 + (0.2 * j) / (ny - 1));
  const z: number[] = [];
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const s = (xs[i]! - 100) / 12;
      z.push(4000 * Math.exp(-s * s) * (1 - 0.6 * (j / (ny - 1))) - 1500);
    }
  }
  return { xs, ys, z, scale: 'diverging' };
}

const camera = (azimuth: number, elevation: number): Camera => ({ azimuth, elevation, distance: 4, rect });

describe('the heatmap', () => {
  it('puts one cell per grid point, vol increasing upward, and picks back to the same point', () => {
    const grid = pnl();
    const cells = heatmapCells(grid, rect);
    expect(cells).toHaveLength(25 * 15);
    const first = cells.find((c) => c.i === 0 && c.j === 0)!;
    const top = cells.find((c) => c.i === 0 && c.j === 14)!;
    expect(first.rect.maxY).toBe(400);
    expect(top.rect.minY).toBeCloseTo(0, 9);
    for (const c of cells) {
      const centre = { x: (c.rect.minX + c.rect.maxX) / 2, y: (c.rect.minY + c.rect.maxY) / 2 };
      const picked = heatmapPick(grid, rect, centre)!;
      expect([picked.i, picked.j, picked.value]).toEqual([c.i, c.j, c.value]);
    }
    expect(heatmapPick(grid, rect, { x: -1, y: 10 })).toBeUndefined();
  });
});

describe('the colours', () => {
  it('are neutral at zero and equally strong for a loss and a gain of the same size', () => {
    const domain = { min: -100, max: 100 };
    const neutral = surfaceColor(0, domain, 'diverging');
    const distance = (c: number[]) => Math.hypot(c[0]! - neutral[0], c[1]! - neutral[1], c[2]! - neutral[2]);
    const loss = surfaceColor(-60, domain, 'diverging');
    const gain = surfaceColor(60, domain, 'diverging');
    expect(loss[0]).toBeGreaterThan(gain[0]);
    // The two ends are different hues at different distances from neutral, so
    // "equally strong" is measured as the same fraction of the way to each end.
    expect(distance(loss) / distance(surfaceColor(-100, domain, 'diverging'))).toBeCloseTo(0.6, 9);
    expect(distance(gain) / distance(surfaceColor(100, domain, 'diverging'))).toBeCloseTo(0.6, 9);
    expect(surfaceColor(Number.NaN, domain, 'diverging')).toEqual([160, 160, 160]);
  });

  it('centre a diverging scale on zero whatever the data, and span a sequential one', () => {
    expect(zDomain({ xs: [0, 1], ys: [0], z: [-20, 300], scale: 'diverging' })).toEqual({ min: -300, max: 300 });
    expect(zDomain({ xs: [0, 1], ys: [0], z: [0.18, 0.31], scale: 'sequential' })).toEqual({ min: 0.18, max: 0.31 });
  });
});

describe('the camera', () => {
  it('puts the centre of the surface at the centre of the rect, and the near side nearer', () => {
    const cam = camera(0.6, 0.5);
    const centre = project(cam, { x: 0, y: 0, z: 0 });
    expect(centre.x).toBeCloseTo(300, 9);
    expect(centre.y).toBeCloseTo(200, 9);
    expect(centre.depth).toBeCloseTo(4, 9);
    // From the front (azimuth 0) the viewer is on the -y side, above the base.
    const front = project(camera(0, 0.5), { x: 0, y: -1, z: 0 });
    const back = project(camera(0, 0.5), { x: 0, y: 1, z: 0 });
    expect(front.depth).toBeLessThan(back.depth);
    expect(front.y).toBeGreaterThan(back.y);
    // Higher is up on screen, and nearer when looking down.
    const high = project(camera(0, 0.5), { x: 0, y: 0, z: 0.5 });
    expect(high.y).toBeLessThan(centre.y);
    expect(high.depth).toBeLessThan(4);
  });

  it('orbits, and stops short of edge-on and overhead', () => {
    const cam = camera(0, 0.5);
    expect(orbit(cam, 100, 0).azimuth).toBeCloseTo(1, 12);
    expect(orbit(cam, 0, 10_000).elevation).toBe(MAX_ELEVATION);
    expect(orbit(cam, 0, -10_000).elevation).toBe(MIN_ELEVATION);
  });

  it('spans the base and scales height to the domain', () => {
    const grid = pnl();
    const d = zDomain(grid);
    expect(worldPoint(grid, d, 0, 0, d.min)).toEqual({ x: -1, y: -1, z: -0.7 });
    expect(worldPoint(grid, d, 24, 14, d.max)).toEqual({ x: 1, y: 1, z: 0.7 });
    expect(worldPoint(grid, d, 12, 7, 0).z).toBeCloseTo(0, 12);
  });
});

/** Interpolated depth of a triangle at a screen point, or undefined outside it. */
function depthAt(t: Triangle, x: number, y: number): number | undefined {
  const [a, b, c] = t.points;
  const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  if (Math.abs(area) < 1e-9) return undefined;
  const w1 = ((b.x - x) * (c.y - y) - (c.x - x) * (b.y - y)) / area;
  const w2 = ((c.x - x) * (a.y - y) - (a.x - x) * (c.y - y)) / area;
  const w3 = 1 - w1 - w2;
  if (w1 < -1e-12 || w2 < -1e-12 || w3 < -1e-12) return undefined;
  return w1 * a.depth + w2 * b.depth + w3 * c.depth;
}

/**
 * At each sample: the nearest surface by depth (an independent depth buffer —
 * no sorting) and the surface the painter leaves on top (the last triangle
 * drawn over it).
 */
function compare(mesh: readonly Triangle[], x: number, y: number) {
  let front: number | undefined;
  let top: number | undefined;
  for (const t of mesh) {
    const d = depthAt(t, x, y);
    if (d === undefined) continue;
    if (front === undefined || d < front) front = d;
    top = d;
  }
  return front === undefined ? undefined : { front, top: top as number };
}

describe('painting order', () => {
  it('never leaves a farther surface on top of a nearer one, from any side', () => {
    // Where the painter and the depth buffer pick different triangles, it is a
    // sample on an edge two triangles share at the same depth: measured over
    // these eighteen views, the painter's surface is never farther than the
    // front one by more than rounding.
    const grid = pnl();
    let worstGap = 0;
    let samples = 0;
    for (const azimuth of [0, 0.7, 1.6, 2.5, 3.6, 4.8]) {
      for (const elevation of [0.25, 0.6, 1.1]) {
        const mesh = surfaceMesh(grid, camera(azimuth, elevation));
        for (let y = 0; y < 400; y += 4) {
          for (let x = 0; x < 600; x += 4) {
            const c = compare(mesh, x, y);
            if (!c) continue;
            samples += 1;
            worstGap = Math.max(worstGap, c.top - c.front);
          }
        }
      }
    }
    expect(samples).toBeGreaterThan(50_000);
    expect(worstGap).toBeLessThan(1e-9);
  });
});

describe('picking in 3D', () => {
  it('returns the grid point under the cursor wherever that point is visible', () => {
    const grid = pnl();
    const d = zDomain(grid);
    for (const [azimuth, elevation] of [[0.6, 0.5], [2.4, 0.9], [4.1, 0.3]] as const) {
      const cam = camera(azimuth, elevation);
      const mesh = surfaceMesh(grid, cam);
      let checked = 0;
      let hidden = 0;
      for (let j = 0; j < 15; j += 1) {
        for (let i = 0; i < 25; i += 1) {
          const p = project(cam, worldPoint(grid, d, i, j, valueAt(grid, i, j)));
          const c = compare(mesh, p.x, p.y)!;
          // Visible: nothing on the surface is nearer at that exact point.
          if (c.front < p.depth - 1e-9) {
            hidden += 1;
            continue;
          }
          const picked = surfacePick(grid, mesh, { x: p.x, y: p.y })!;
          expect([picked.i, picked.j]).toEqual([i, j]);
          expect(picked.value).toBe(valueAt(grid, i, j));
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(200);
      expect(checked + hidden).toBe(25 * 15);
    }
  });

  it('leaves out a cell with a missing corner rather than drawing through it', () => {
    const grid = pnl(4, 3);
    const z = [...(grid.z as number[])];
    z[5] = Number.NaN;
    const mesh = surfaceMesh({ ...grid, z }, camera(0.5, 0.5));
    // The corner at (1, 1) touches four cells: those eight triangles go.
    expect(mesh).toHaveLength(3 * 2 * 2 - 8);
  });
});

describe('the break-even line', () => {
  it('crosses every cell edge exactly where the edge interpolates to zero', () => {
    const grid = pnl();
    const segments = contour(grid);
    expect(segments.length).toBeGreaterThan(10);
    const along = (fi: number, fj: number) => {
      // On an edge one coordinate is whole; interpolate linearly along the other.
      if (Number.isInteger(fi)) {
        const j0 = Math.floor(fj);
        const t = fj - j0;
        return valueAt(grid, fi, j0) * (1 - t) + valueAt(grid, fi, Math.min(j0 + 1, 14)) * t;
      }
      const i0 = Math.floor(fi);
      const t = fi - i0;
      return valueAt(grid, i0, fj) * (1 - t) + valueAt(grid, Math.min(i0 + 1, 24), fj) * t;
    };
    for (const [a, b] of segments) {
      for (const p of [a, b]) expect(Math.abs(along(p.i, p.j))).toBeLessThan(1e-9);
    }
  });

  it('is a straight line where the surface is a plane', () => {
    const xs = [0, 1, 2, 3, 4];
    const ys = [0, 1, 2];
    const z = ys.flatMap(() => xs.map((x) => x - 2.5));
    const segments = contour({ xs, ys, z, scale: 'diverging' });
    expect(segments).toHaveLength(2);
    for (const [a, b] of segments) expect([a.i, b.i]).toEqual([2.5, 2.5]);
  });

  it('resolves a saddle by the cell mean, into two segments', () => {
    const segments = contour({ xs: [0, 1], ys: [0, 1], z: [1, -1, 1.5, -2].slice(0, 2).concat([-2, 1.5]), scale: 'diverging' });
    expect(segments).toHaveLength(2);
  });
});
