/** Pure level-of-detail helpers: point decimation + viewport bboxes (Step 11). */

export type LngLat = [number, number];
export type BBox = [number, number, number, number]; // west, south, east, north

type Datum = Record<string, unknown>;

/**
 * Grid-based decimation: bucket points into a lng/lat grid and keep the highest-
 * priority point per cell (by `priorityField`, descending; first-seen otherwise).
 * Deterministic and O(n). Use when a point dataset exceeds what a zoom level can show.
 */
export function decimatePoints<T extends Datum>(
  rows: readonly T[],
  maxPoints: number,
  options: {
    getPosition?: (d: T) => LngLat;
    priorityField?: string;
  } = {},
): T[] {
  if (rows.length <= maxPoints) return [...rows];
  const getPosition = options.getPosition ?? ((d: T) => [Number(d.lng), Number(d.lat)] as LngLat);
  const priority = options.priorityField;

  // ~sqrt(maxPoints) cells per axis lands near maxPoints occupied cells.
  const cellsPerAxis = Math.max(1, Math.floor(Math.sqrt(maxPoints)));
  const cellW = 360 / cellsPerAxis;
  const cellH = 180 / cellsPerAxis;

  const best = new Map<string, T>();
  for (const row of rows) {
    const [lng, lat] = getPosition(row);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const key = `${Math.floor((lng + 180) / cellW)}:${Math.floor((lat + 90) / cellH)}`;
    const current = best.get(key);
    if (current === undefined) {
      best.set(key, row);
    } else if (priority && Number(row[priority]) > Number(current[priority])) {
      best.set(key, row);
    }
  }

  const kept = [...best.values()];
  if (kept.length <= maxPoints) return kept;
  if (priority) kept.sort((a, b) => Number(b[priority]) - Number(a[priority]));
  return kept.slice(0, maxPoints);
}

/** Point budget for a zoom level: sparse when zoomed out, full detail when zoomed in. */
export function pointBudgetForZoom(zoom: number, base = 1500, max = 50_000): number {
  return Math.min(max, Math.round(base * 2 ** Math.max(0, zoom)));
}

/**
 * A coarse bbox around the viewport for viewport-bounded queries. The span shrinks with
 * zoom and edges snap to `snapDeg`, so small camera moves reuse the same bbox (and the
 * same query-cache entry) instead of refetching every frame. Returns null when zoomed
 * out far enough that the whole globe is visible.
 */
export function coarseViewportBbox(
  viewport: { longitude: number; latitude: number; zoom: number },
  options: { minZoom?: number; snapDeg?: number } = {},
): BBox | null {
  const { minZoom = 3, snapDeg = 10 } = options;
  if (viewport.zoom < minZoom) return null;

  const half = Math.min(90, 180 / 2 ** (viewport.zoom - 1));
  const down = (v: number) => Math.floor(v / snapDeg) * snapDeg;
  const up = (v: number) => Math.ceil(v / snapDeg) * snapDeg;

  return [
    Math.max(-180, down(viewport.longitude - half)),
    Math.max(-90, down(viewport.latitude - half)),
    Math.min(180, up(viewport.longitude + half)),
    Math.min(90, up(viewport.latitude + half)),
  ];
}
