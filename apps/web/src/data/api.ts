import type { Layer } from '@geoglobe/scene-schema';

/** Base URL of the Data Service (Step 5). Overridable via VITE_API_URL. */
export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

interface GeoQueryBody {
  dataset: string;
  bbox?: [number, number, number, number];
  center?: [number, number];
  radius_km?: number;
  filters?: Record<string, { op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'; value: number }>;
  limit?: number;
}

interface GeoQueryResponse {
  dataset: string;
  count: number;
  features: Record<string, unknown>[];
  truncated: boolean;
}

/**
 * Resolve a `geo-query` layer against POST /query/geo, returning flat records ready to
 * hand to deck.gl as `resolvedData`. The layer's `source.filter` is translated into the
 * API's filter shape.
 */
export async function fetchGeoQuery(
  layer: Layer,
  signal?: AbortSignal,
): Promise<Record<string, unknown>[]> {
  if (layer.source.kind !== 'geo-query') {
    throw new Error(`fetchGeoQuery called on a non geo-query layer: ${layer.id}`);
  }
  const body: GeoQueryBody = {
    dataset: layer.source.dataset,
    filters: normalizeFilters(layer.source.filter),
    limit: 5000,
  };
  const res = await fetch(`${API_URL}/query/geo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`geo query failed: ${res.status}`);
  const data = (await res.json()) as GeoQueryResponse;
  return data.features;
}

/** Translate a Scene State source filter ({ mag: { gte: 4.5 } }) into API predicates. */
function normalizeFilters(filter: Record<string, unknown> | undefined): GeoQueryBody['filters'] {
  if (!filter) return undefined;
  const out: NonNullable<GeoQueryBody['filters']> = {};
  for (const [field, pred] of Object.entries(filter)) {
    if (pred && typeof pred === 'object') {
      const [op, value] = Object.entries(pred as Record<string, number>)[0] ?? [];
      if (op && typeof value === 'number' && ['eq', 'gt', 'gte', 'lt', 'lte'].includes(op)) {
        out[field] = { op: op as 'gte', value };
      }
    }
  }
  return out;
}
