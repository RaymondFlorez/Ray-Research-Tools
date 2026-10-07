/**
 * `SurfaceNode`: a grid drawn as a heatmap or as a 3D surface (PRD 3.3, 5.4).
 *
 * > `SurfaceNode`: 3D or heatmap rendering of a grid (vol surface, payoff,
 * > scenario matrix).
 *
 * > [StrategyNode] Rendering supports the classic payoff view, a P&L heatmap in
 * > spot-time space, and a 3D surface.
 *
 * Everything here is geometry, so it can be tested without a canvas: where each
 * heatmap cell goes, where each grid point lands on screen under an orbit
 * camera, which order to paint the mesh in, which grid point the cursor is on,
 * and where the surface crosses zero. Drawing is the caller's, in a dozen
 * lines.
 *
 * **Grid points are the data, and nothing is interpolated into a readout.** A
 * P&L grid is a set of full revaluations at chosen spots and vols; between two
 * of them there is no number, only a guess. So a pick returns the nearest grid
 * point and its value, in the heatmap and in 3D alike, and the only
 * interpolation anywhere is the one the zero contour needs to be drawn at all —
 * linear along a cell edge, and drawn as a line, not reported as a value.
 *
 * **The mesh is painted back to front, and that is checked, not assumed.**
 * Canvas2D has no depth buffer, so the triangles are sorted by the depth of
 * their centroids and drawn far to near. That can go wrong — a long far
 * triangle can sort after a short near one — so the tests compute the front
 * surface independently, by depth at each sample, with no sorting at all. On a
 * P&L-shaped surface from eighteen views, over 50,000 samples, the painter
 * never leaves a farther surface on top: where it picks a different triangle
 * from the depth buffer, the two are at the same depth on a shared edge. That
 * is a measurement on those views, not a proof for every surface; a grid much
 * coarser than its features is where it would fail first.
 */

import { createNode, type NodeID, type PicassoNode, type Port, type Rect, type Vec2 } from '@picasso/canvas-core';

/** A `SurfaceNode` takes one `surface`: a StrategyNode's P&L, a fitted vol surface, a scenario grid. */
export function surfacePorts(): { inputs: Port[]; outputs: Port[] } {
  return {
    inputs: [{ id: 'grid', name: 'Surface', type: 'surface', cardinality: 'one', required: true }],
    outputs: [],
  };
}

/**
 * A `SurfaceNode`. `view` is the one parameter: the heatmap or the 3D surface.
 * The camera is not a parameter — turning the surface is looking at it, not
 * changing it, and a parameter would move the node's cache key on every drag.
 */
export function createSurfaceNode(input: {
  id: NodeID;
  view?: 'heatmap' | '3d';
  position?: Vec2;
  provenance?: PicassoNode['provenance'];
}): PicassoNode {
  return createNode({
    id: input.id,
    kind: 'SurfaceNode',
    binding: 'wired',
    position: input.position ?? { x: 0, y: 0 },
    size: { w: 420, h: 300 },
    ...surfacePorts(),
    params: { view: input.view ?? 'heatmap' },
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
}

/** A grid of values over two ascending axes, row-major: `z[j * xs.length + i]`. */
export interface SurfaceGrid {
  xs: readonly number[];
  ys: readonly number[];
  z: ArrayLike<number>;
  /**
   * `diverging` for a P&L, centred on zero so a loss and a gain of the same size
   * get the same strength of colour; `sequential` for a level, such as a vol
   * surface.
   */
  scale: 'diverging' | 'sequential';
}

export function valueAt(grid: SurfaceGrid, i: number, j: number): number {
  return grid.z[j * grid.xs.length + i] as number;
}

/** The range the colours and the height are scaled over. */
export function zDomain(grid: SurfaceGrid): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < grid.z.length; k += 1) {
    const v = grid.z[k] as number;
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (grid.scale === 'diverging') {
    const extent = Math.max(Math.abs(min), Math.abs(max)) || 1;
    return { min: -extent, max: extent };
  }
  return min < max ? { min, max } : { min: min - 1, max: max + 1 };
}

export type Rgb = [number, number, number];

const LOSS: Rgb = [181, 83, 42];
const NEUTRAL: Rgb = [242, 240, 235];
const GAIN: Rgb = [47, 125, 79];
const LOW: Rgb = [38, 70, 120];
const MID: Rgb = [70, 150, 150];
const HIGH: Rgb = [235, 200, 80];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * The colour of a value. Diverging: neutral at zero, loss and gain growing
 * symmetrically to the larger of the two extremes. Sequential: low to high.
 * A non-finite value is drawn neutral grey rather than coloured as a number.
 */
export function surfaceColor(value: number, domain: { min: number; max: number }, scale: SurfaceGrid['scale']): Rgb {
  if (!Number.isFinite(value)) return [160, 160, 160];
  if (scale === 'diverging') {
    const t = Math.max(-1, Math.min(1, value / domain.max));
    return t < 0 ? mix(NEUTRAL, LOSS, -t) : mix(NEUTRAL, GAIN, t);
  }
  const t = Math.max(0, Math.min(1, (value - domain.min) / (domain.max - domain.min)));
  return t < 0.5 ? mix(LOW, MID, t * 2) : mix(MID, HIGH, (t - 0.5) * 2);
}

// ---------------------------------------------------------------------------
// Heatmap.
// ---------------------------------------------------------------------------

export interface HeatCell {
  i: number;
  j: number;
  rect: Rect;
  value: number;
}

/** One cell per grid point; `ys` increases upward, as a surface is read. */
export function heatmapCells(grid: SurfaceGrid, rect: Rect): HeatCell[] {
  const nx = grid.xs.length;
  const ny = grid.ys.length;
  const w = (rect.maxX - rect.minX) / nx;
  const h = (rect.maxY - rect.minY) / ny;
  const cells: HeatCell[] = [];
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const minX = rect.minX + i * w;
      const maxY = rect.maxY - j * h;
      cells.push({ i, j, rect: { minX, minY: maxY - h, maxX: minX + w, maxY }, value: valueAt(grid, i, j) });
    }
  }
  return cells;
}

export interface Picked {
  i: number;
  j: number;
  x: number;
  y: number;
  value: number;
}

export function heatmapPick(grid: SurfaceGrid, rect: Rect, point: Vec2): Picked | undefined {
  if (point.x < rect.minX || point.x >= rect.maxX || point.y <= rect.minY || point.y > rect.maxY) return undefined;
  const nx = grid.xs.length;
  const ny = grid.ys.length;
  const i = Math.min(nx - 1, Math.floor(((point.x - rect.minX) / (rect.maxX - rect.minX)) * nx));
  const j = Math.min(ny - 1, Math.floor(((rect.maxY - point.y) / (rect.maxY - rect.minY)) * ny));
  return { i, j, x: grid.xs[i] as number, y: grid.ys[j] as number, value: valueAt(grid, i, j) };
}

/** A grid-space point (fractional indices) at the centre of its heatmap cell. */
export function heatmapPoint(grid: SurfaceGrid, rect: Rect, fi: number, fj: number): Vec2 {
  const nx = grid.xs.length;
  const ny = grid.ys.length;
  return {
    x: rect.minX + ((fi + 0.5) / nx) * (rect.maxX - rect.minX),
    y: rect.maxY - ((fj + 0.5) / ny) * (rect.maxY - rect.minY),
  };
}

// ---------------------------------------------------------------------------
// 3D.
// ---------------------------------------------------------------------------

/** An orbit camera around the surface's centre. Angles in radians. */
export interface Camera {
  /** Rotation about the vertical axis. */
  azimuth: number;
  /** Angle above the horizontal: zero is edge-on, π/2 straight down. */
  elevation: number;
  /** Distance from the centre, in units of the half-width of the base. */
  distance: number;
  /** The screen rect the surface is fitted into. */
  rect: Rect;
}

export const MIN_ELEVATION = (5 * Math.PI) / 180;
export const MAX_ELEVATION = (85 * Math.PI) / 180;

/** A drag on the 3D view: horizontal turns, vertical tilts, clamped short of edge-on and overhead. */
export function orbit(camera: Camera, dx: number, dy: number, radiansPerPixel = 0.01): Camera {
  const elevation = Math.max(MIN_ELEVATION, Math.min(MAX_ELEVATION, camera.elevation + dy * radiansPerPixel));
  return { ...camera, azimuth: camera.azimuth + dx * radiansPerPixel, elevation };
}

/** Height of the surface's tallest point, against a base of half-width one. */
const HEIGHT = 0.7;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A grid point in the world the camera looks at: the base spans [-1, 1]², height ±0.7. */
export function worldPoint(grid: SurfaceGrid, domain: { min: number; max: number }, fi: number, fj: number, value: number): Vec3 {
  const nx = grid.xs.length;
  const ny = grid.ys.length;
  const t = (value - domain.min) / (domain.max - domain.min);
  return {
    x: nx > 1 ? (fi / (nx - 1)) * 2 - 1 : 0,
    y: ny > 1 ? (fj / (ny - 1)) * 2 - 1 : 0,
    z: (t * 2 - 1) * HEIGHT,
  };
}

export interface Projected {
  x: number;
  y: number;
  /** Distance along the view direction: larger is farther. */
  depth: number;
}

/** Perspective projection under the orbit camera. */
export function project(camera: Camera, p: Vec3): Projected {
  const { azimuth: a, elevation: e, distance } = camera;
  const x1 = p.x * Math.cos(a) - p.y * Math.sin(a);
  const y1 = p.x * Math.sin(a) + p.y * Math.cos(a);
  // The viewer sits at -y1, raised by the elevation, looking at the centre.
  const depth = distance + y1 * Math.cos(e) - p.z * Math.sin(e);
  const up = y1 * Math.sin(e) + p.z * Math.cos(e);
  const r = camera.rect;
  const scale = Math.min(r.maxX - r.minX, r.maxY - r.minY) * 0.36;
  const k = distance / depth;
  return {
    x: (r.minX + r.maxX) / 2 + scale * x1 * k,
    y: (r.minY + r.maxY) / 2 - scale * up * k,
    depth,
  };
}

export interface Triangle {
  /** The cell's lower-left grid point. */
  i: number;
  j: number;
  /** Grid indices of the three corners, for picking. */
  corners: Array<[number, number]>;
  points: [Projected, Projected, Projected];
  /** Mean of the three corners' values, for the fill. */
  value: number;
  /** Lambert shade in [0.55, 1]: light from over the viewer's left shoulder. */
  shade: number;
  depth: number;
}

const LIGHT: Vec3 = (() => {
  const v = { x: -0.4, y: -0.5, z: 0.75 };
  const n = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / n, y: v.y / n, z: v.z / n };
})();

/**
 * The surface as triangles, two per cell, in painting order: farthest first.
 * A cell with a non-finite corner is left out rather than drawn through.
 */
export function surfaceMesh(grid: SurfaceGrid, camera: Camera): Triangle[] {
  const nx = grid.xs.length;
  const ny = grid.ys.length;
  const domain = zDomain(grid);
  const world: Vec3[] = [];
  const screen: Projected[] = [];
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const w = worldPoint(grid, domain, i, j, valueAt(grid, i, j));
      world.push(w);
      screen.push(project(camera, w));
    }
  }
  const tris: Triangle[] = [];
  const at = (i: number, j: number) => j * nx + i;
  for (let j = 0; j + 1 < ny; j += 1) {
    for (let i = 0; i + 1 < nx; i += 1) {
      const quad: Array<[number, number]> = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      if (quad.some(([a, b]) => !Number.isFinite(valueAt(grid, a, b)))) continue;
      for (const corners of [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]] as Array<Array<[number, number]>>) {
        const [p, q, r] = corners.map(([a, b]) => world[at(a, b)] as Vec3) as [Vec3, Vec3, Vec3];
        const u = { x: q.x - p.x, y: q.y - p.y, z: q.z - p.z };
        const v = { x: r.x - p.x, y: r.y - p.y, z: r.z - p.z };
        let n = { x: u.y * v.z - u.z * v.y, y: u.z * v.x - u.x * v.z, z: u.x * v.y - u.y * v.x };
        const len = Math.hypot(n.x, n.y, n.z) || 1;
        n = { x: n.x / len, y: n.y / len, z: n.z / len };
        if (n.z < 0) n = { x: -n.x, y: -n.y, z: -n.z };
        const lambert = Math.max(0, n.x * LIGHT.x + n.y * LIGHT.y + n.z * LIGHT.z);
        const points = corners.map(([a, b]) => screen[at(a, b)] as Projected) as [Projected, Projected, Projected];
        tris.push({
          i,
          j,
          corners,
          points,
          value: corners.reduce((s, [a, b]) => s + valueAt(grid, a, b), 0) / 3,
          shade: 0.55 + 0.45 * lambert,
          depth: (points[0].depth + points[1].depth + points[2].depth) / 3,
        });
      }
    }
  }
  return tris.sort((x, y) => y.depth - x.depth);
}

function inside(t: Triangle, p: Vec2): boolean {
  const [a, b, c] = t.points;
  const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
  const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * The depth of the nearest surface at a screen point, or undefined off the
 * surface. For hiding what a ridge covers — the break-even line, a marker —
 * since a Canvas2D overlay has no depth test of its own.
 */
export function frontDepth(mesh: readonly Triangle[], point: Vec2): number | undefined {
  let best: number | undefined;
  for (const t of mesh) {
    const [a, b, c] = t.points;
    const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(area) < 1e-12) continue;
    const w1 = ((b.x - point.x) * (c.y - point.y) - (c.x - point.x) * (b.y - point.y)) / area;
    const w2 = ((c.x - point.x) * (a.y - point.y) - (a.x - point.x) * (c.y - point.y)) / area;
    const w3 = 1 - w1 - w2;
    if (w1 < 0 || w2 < 0 || w3 < 0) continue;
    const d = w1 * a.depth + w2 * b.depth + w3 * c.depth;
    if (best === undefined || d < best) best = d;
  }
  return best;
}

/**
 * The grid point under the cursor in 3D: the front-most triangle that contains
 * it — the last one painted — and, of its three corners, the nearest on screen.
 */
export function surfacePick(grid: SurfaceGrid, mesh: readonly Triangle[], point: Vec2): Picked | undefined {
  for (let k = mesh.length - 1; k >= 0; k -= 1) {
    const t = mesh[k] as Triangle;
    if (!inside(t, point)) continue;
    let best = 0;
    let bestD = Infinity;
    t.points.forEach((p, n) => {
      const d = Math.hypot(p.x - point.x, p.y - point.y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    });
    const [i, j] = t.corners[best] as [number, number];
    return { i, j, x: grid.xs[i] as number, y: grid.ys[j] as number, value: valueAt(grid, i, j) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The zero contour: where a P&L surface breaks even.
// ---------------------------------------------------------------------------

/** A segment in grid space: fractional `(i, j)` at each end. */
export type Segment = [{ i: number; j: number }, { i: number; j: number }];

/**
 * Marching squares at `level` (zero by default: break-even). Crossings are
 * placed by linear interpolation along each cell edge, and a saddle — opposite
 * corners on the same side — is resolved by the cell's mean.
 */
export function contour(grid: SurfaceGrid, level = 0): Segment[] {
  const nx = grid.xs.length;
  const ny = grid.ys.length;
  const out: Segment[] = [];
  const v = (i: number, j: number) => valueAt(grid, i, j) - level;
  const cross = (i0: number, j0: number, i1: number, j1: number) => {
    const a = v(i0, j0);
    const b = v(i1, j1);
    const t = a / (a - b);
    return { i: i0 + (i1 - i0) * t, j: j0 + (j1 - j0) * t };
  };
  for (let j = 0; j + 1 < ny; j += 1) {
    for (let i = 0; i + 1 < nx; i += 1) {
      const c = [v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)];
      if (c.some((x) => !Number.isFinite(x))) continue;
      // Edges: bottom, right, top, left, as (from corner, to corner).
      const edges: Array<[[number, number], [number, number]]> = [
        [[i, j], [i + 1, j]],
        [[i + 1, j], [i + 1, j + 1]],
        [[i + 1, j + 1], [i, j + 1]],
        [[i, j + 1], [i, j]],
      ];
      const above = c.map((x) => x > 0);
      const hits = edges
        .map((e, k) => ({ k, e }))
        .filter(({ k }) => above[k] !== above[(k + 1) % 4])
        .map(({ e }) => cross(e[0][0], e[0][1], e[1][0], e[1][1]));
      if (hits.length === 2) {
        out.push([hits[0]!, hits[1]!]);
      } else if (hits.length === 4) {
        // A saddle. The cell's mean says which pair of corners is connected.
        const centreAbove = (c[0]! + c[1]! + c[2]! + c[3]!) / 4 > 0;
        if (centreAbove === above[0]) {
          out.push([hits[0]!, hits[1]!], [hits[2]!, hits[3]!]);
        } else {
          out.push([hits[3]!, hits[0]!], [hits[1]!, hits[2]!]);
        }
      }
    }
  }
  return out;
}
