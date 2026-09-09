/**
 * Path geometry for ink.
 *
 * Everything the recognizer needs that is not itself a decision: resampling,
 * simplification, turning angles, corner detection, hulls and fits. Kept
 * separate from `recognize.ts` so the classification rules read as rules rather
 * than as arithmetic.
 */

import type { Rect, Vec2 } from '@picasso/canvas-core';

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function pathLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1] as Vec2, points[i] as Vec2);
  }
  return total;
}

export function bounds(points: readonly Vec2[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function centroid(points: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, points.length);
  return { x: x / n, y: y / n };
}

/**
 * Resamples to `count` points spaced evenly along the path. Speed carries no
 * shape information, and a stylus samples fast on slow strokes, so every
 * downstream feature works on an arc-length parameterization.
 */
export function resample(points: readonly Vec2[], count = 64): Vec2[] {
  if (points.length === 0) return [];
  if (points.length === 1 || count < 2) return [{ ...(points[0] as Vec2) }];

  const total = pathLength(points);
  if (total === 0) return Array.from({ length: count }, () => ({ ...(points[0] as Vec2) }));

  const interval = total / (count - 1);
  const out: Vec2[] = [{ ...(points[0] as Vec2) }];
  let accumulated = 0;
  let previous = points[0] as Vec2;

  for (let i = 1; i < points.length; i++) {
    const current = points[i] as Vec2;
    let segment = distance(previous, current);
    while (accumulated + segment >= interval && out.length < count) {
      const t = (interval - accumulated) / segment;
      const next = {
        x: previous.x + (current.x - previous.x) * t,
        y: previous.y + (current.y - previous.y) * t,
      };
      out.push(next);
      previous = next;
      segment = distance(previous, current);
      accumulated = 0;
    }
    accumulated += segment;
    previous = current;
  }

  // Floating point can leave the last point short.
  while (out.length < count) out.push({ ...(points[points.length - 1] as Vec2) });
  return out;
}

/**
 * Ramer-Douglas-Peucker. Run on stroke commit: a stylus at 240Hz produces far
 * more points than the shape carries, and every one of them is a CRDT entry.
 */
export function simplify<T extends Vec2>(points: readonly T[], tolerance = 1): T[] {
  if (points.length <= 2) return [...points];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    let worst = 0;
    let worstIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(
        points[i] as Vec2,
        points[start] as Vec2,
        points[end] as Vec2,
      );
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worstIndex !== -1 && worst > tolerance) {
      keep[worstIndex] = 1;
      stack.push([start, worstIndex], [worstIndex, end]);
    }
  }

  const out: T[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i] as T);
  return out;
}

export function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/**
 * Light 1-2-1 smoothing, applied before any curvature analysis.
 *
 * Hand tremor puts a millimetre of wobble on every stroke. On an arc-length
 * resampled path the samples are close together, so that wobble shows up as
 * large per-sample turning angles and manufactures corners that the hand never
 * drew. Endpoints are pinned, because they carry the closure feature.
 */
export function smoothPath(points: readonly Vec2[], passes = 2): Vec2[] {
  if (points.length < 3) return [...points];
  let current = [...points];
  for (let pass = 0; pass < passes; pass++) {
    const next: Vec2[] = [current[0] as Vec2];
    for (let i = 1; i < current.length - 1; i++) {
      const a = current[i - 1] as Vec2;
      const b = current[i] as Vec2;
      const c = current[i + 1] as Vec2;
      next.push({ x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4 });
    }
    next.push(current[current.length - 1] as Vec2);
    current = next;
  }
  return current;
}

/** Signed turn at each interior point, in radians, from a resampled path. */
export function turningAngles(points: readonly Vec2[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1] as Vec2;
    const here = points[i] as Vec2;
    const next = points[i + 1] as Vec2;
    const a = Math.atan2(here.y - prev.y, here.x - prev.x);
    const b = Math.atan2(next.y - here.y, next.x - here.x);
    let turn = b - a;
    while (turn > Math.PI) turn -= 2 * Math.PI;
    while (turn < -Math.PI) turn += 2 * Math.PI;
    out.push(turn);
  }
  return out;
}

export interface Corner {
  /** Index into the resampled path. */
  index: number;
  /** Total turning accumulated across the corner, in radians. */
  angle: number;
}

/**
 * Corner detection over a smoothed turning function.
 *
 * A hand-drawn corner spreads its turn across several samples, so a raw
 * per-point threshold either misses gentle corners or splits sharp ones in two.
 * Turning is summed over a window, then peaks are picked greedily with a
 * suppression radius.
 */
export function detectCorners(
  points: readonly Vec2[],
  options: { window?: number; minAngle?: number; suppression?: number } = {},
): Corner[] {
  // Suppression must be at least as wide as the window. A hand-drawn corner
  // spreads its turn over several samples, so the windowed sum peaks twice
  // around it; a suppression radius narrower than the window reports one
  // corner as two, and a rectangle then looks like it has eight.
  const { window = 3, minAngle = Math.PI / 4, suppression = window * 2 } = options;
  const turns = turningAngles(points);
  if (turns.length === 0) return [];

  // Windowed sum of turning, centred on each interior sample.
  const scores: number[] = new Array(turns.length).fill(0);
  for (let i = 0; i < turns.length; i++) {
    let sum = 0;
    for (let k = -window; k <= window; k++) {
      const j = i + k;
      if (j >= 0 && j < turns.length) sum += turns[j] as number;
    }
    scores[i] = sum;
  }

  const order = scores
    .map((score, i) => ({ i, magnitude: Math.abs(score) }))
    .sort((a, b) => b.magnitude - a.magnitude);

  const taken: Corner[] = [];
  for (const candidate of order) {
    if (candidate.magnitude < minAngle) break;
    if (taken.some((c) => Math.abs(c.index - (candidate.i + 1)) < suppression)) continue;
    taken.push({ index: candidate.i + 1, angle: scores[candidate.i] as number });
  }
  return taken.sort((a, b) => a.index - b.index);
}

/** Total absolute turning, in radians. A clean closed loop is about 2π. */
export function totalAbsoluteTurning(points: readonly Vec2[]): number {
  return turningAngles(points).reduce((sum, t) => sum + Math.abs(t), 0);
}

/** Signed turning; sign gives the winding direction of a closed stroke. */
export function totalSignedTurning(points: readonly Vec2[]): number {
  return turningAngles(points).reduce((sum, t) => sum + t, 0);
}

/** Andrew's monotone chain. */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const build = (source: Vec2[]): Vec2[] => {
    const stack: Vec2[] = [];
    for (const p of source) {
      while (
        stack.length >= 2 &&
        cross(stack[stack.length - 2] as Vec2, stack[stack.length - 1] as Vec2, p) <= 0
      ) {
        stack.pop();
      }
      stack.push(p);
    }
    stack.pop();
    return stack;
  };

  return [...build(sorted), ...build([...sorted].reverse())];
}

export function polygonArea(points: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Vec2;
    const b = points[(i + 1) % points.length] as Vec2;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.maxX - r.minX) * Math.max(0, r.maxY - r.minY);
}

export function rectDiagonal(r: Rect): number {
  return Math.hypot(r.maxX - r.minX, r.maxY - r.minY);
}

/**
 * Mean normalized residual of the points against the bounding-box-aligned
 * ellipse. Near 0 for a drawn ellipse, well above for a rectangle.
 */
export function ellipseResidual(points: readonly Vec2[], box: Rect): number {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const rx = Math.max(1e-9, (box.maxX - box.minX) / 2);
  const ry = Math.max(1e-9, (box.maxY - box.minY) / 2);

  let sum = 0;
  for (const p of points) {
    const nx = (p.x - cx) / rx;
    const ny = (p.y - cy) / ry;
    // Radial deviation from the unit circle in normalized space.
    sum += Math.abs(Math.hypot(nx, ny) - 1);
  }
  return sum / Math.max(1, points.length);
}

export interface OrientedBox {
  center: Vec2;
  /** Unit vector along the major axis. */
  u: Vec2;
  /** Unit vector along the minor axis. */
  v: Vec2;
  halfU: number;
  halfV: number;
}

/**
 * Principal axes of the point cloud, giving an oriented bounding box.
 *
 * People draw tilted ovals. Fitting against the axis-aligned bounding box makes
 * a 45-degree ellipse look like a poor ellipse and a good nothing, so the
 * ellipse fit works in this frame instead.
 */
export function principalAxes(points: readonly Vec2[]): OrientedBox {
  const center = centroid(points);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const n = Math.max(1, points.length);
  sxx /= n;
  sxy /= n;
  syy /= n;

  // Closed form for the dominant eigenvector of a symmetric 2x2 matrix.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const u = { x: Math.cos(theta), y: Math.sin(theta) };
  const v = { x: -u.y, y: u.x };

  let halfU = 0;
  let halfV = 0;
  for (const p of points) {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    halfU = Math.max(halfU, Math.abs(dx * u.x + dy * u.y));
    halfV = Math.max(halfV, Math.abs(dx * v.x + dy * v.y));
  }
  return { center, u, v, halfU: Math.max(halfU, 1e-9), halfV: Math.max(halfV, 1e-9) };
}

/** Mean radial deviation from the ellipse inscribed in the oriented box. */
export function orientedEllipseResidual(points: readonly Vec2[], box: OrientedBox): number {
  let sum = 0;
  for (const p of points) {
    const dx = p.x - box.center.x;
    const dy = p.y - box.center.y;
    const du = (dx * box.u.x + dy * box.u.y) / box.halfU;
    const dv = (dx * box.v.x + dy * box.v.y) / box.halfV;
    sum += Math.abs(Math.hypot(du, dv) - 1);
  }
  return sum / Math.max(1, points.length);
}

export function orientedBoxArea(box: OrientedBox): number {
  return 4 * box.halfU * box.halfV;
}

/**
 * Fraction of points lying within `tolerance` of the bounding box perimeter,
 * with tolerance expressed as a fraction of the box diagonal.
 */
export function perimeterCoverage(
  points: readonly Vec2[],
  box: Rect,
  tolerance = 0.12,
): number {
  const limit = rectDiagonal(box) * tolerance;
  if (limit === 0) return 0;
  let inside = 0;
  for (const p of points) {
    const d = Math.min(
      Math.abs(p.x - box.minX),
      Math.abs(p.x - box.maxX),
      Math.abs(p.y - box.minY),
      Math.abs(p.y - box.maxY),
    );
    if (d <= limit) inside += 1;
  }
  return inside / Math.max(1, points.length);
}

/** Fraction of segment length running within `slack` radians of an axis. */
export function axisAlignment(points: readonly Vec2[], slack = Math.PI / 9): number {
  let aligned = 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec2;
    const b = points[i] as Vec2;
    const length = distance(a, b);
    if (length === 0) continue;
    total += length;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    // Fold into [0, π/2): distance to the nearest axis direction.
    const folded = Math.abs(((Math.abs(angle) % Math.PI) - Math.PI / 2));
    const toAxis = Math.min(folded, Math.PI / 2 - folded);
    if (toAxis <= slack) aligned += length;
  }
  return total === 0 ? 0 : aligned / total;
}
