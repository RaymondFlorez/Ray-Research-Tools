import { useEffect, useState } from 'react';
import type { Layer } from '@geoglobe/scene-schema';
import type { BBox } from '@geoglobe/layer-adapters';
import { fetchGeoQuery } from './api';

export type LoadStatus = 'loading' | 'ready' | 'empty' | 'error';

export interface ResolvedData {
  /** layerId → records for the renderer's `resolvedData`. */
  data: Record<string, Record<string, unknown>[]>;
  /** layerId → load status, for the Layer panel's badges. Only geo-query layers appear. */
  status: Record<string, LoadStatus>;
}

/**
 * Fetches data for every `geo-query` layer from the Data Service. Layers whose fetch fails
 * (e.g. the backend isn't running) are omitted from `data` and marked `error`, so the globe
 * still works standalone and the UI can say why a layer is blank.
 */
export function useResolvedData(layers: Layer[], bbox: BBox | null = null): ResolvedData {
  const [resolved, setResolved] = useState<ResolvedData>({ data: {}, status: {} });

  // Refetch only when the set of geo-query layers (id + serialized source) or the snapped
  // viewport bbox changes — never on opacity/camera-only patches.
  const key =
    layers
      .filter((l) => l.source.kind === 'geo-query')
      .map((l) => `${l.id}:${JSON.stringify(l.source)}`)
      .join('|') + `@${bbox ? bbox.join(',') : 'world'}`;

  useEffect(() => {
    const geoLayers = layers.filter((l) => l.source.kind === 'geo-query');
    if (geoLayers.length === 0) {
      setResolved({ data: {}, status: {} });
      return;
    }
    const controller = new AbortController();
    let cancelled = false;

    // Keep the previous data while refetching so the globe doesn't flash empty.
    setResolved((prev) => ({
      data: prev.data,
      status: Object.fromEntries(geoLayers.map((l) => [l.id, 'loading' as const])),
    }));

    Promise.all(
      geoLayers.map(async (layer) => {
        try {
          const rows = await fetchGeoQuery(layer, controller.signal, bbox);
          return [layer.id, rows] as const;
        } catch {
          return [layer.id, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const data: ResolvedData['data'] = {};
      const status: ResolvedData['status'] = {};
      for (const [id, rows] of entries) {
        if (rows === null) {
          status[id] = 'error';
        } else {
          data[id] = rows;
          status[id] = rows.length === 0 ? 'empty' : 'ready';
        }
      }
      setResolved({ data, status });
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Intentionally keyed on `key` (the serialized geo-query layer set + bbox), not
    // `layers`: unrelated patches (opacity, viewport) must not trigger a refetch.
  }, [key]);

  return resolved;
}
