import { useEffect, useState } from 'react';
import type { Layer } from '@geoglobe/scene-schema';
import { fetchGeoQuery } from './api';

/**
 * Fetches data for every `geo-query` layer from the Data Service and returns a map of
 * layerId → records for the renderer's `resolvedData`. Layers whose fetch fails (e.g. the
 * backend isn't running) are simply omitted, so the globe still works standalone.
 */
export function useResolvedData(layers: Layer[]): Record<string, Record<string, unknown>[]> {
  const [resolved, setResolved] = useState<Record<string, Record<string, unknown>[]>>({});

  // Refetch only when the set of geo-query layers (id + serialized source) changes.
  const key = layers
    .filter((l) => l.source.kind === 'geo-query')
    .map((l) => `${l.id}:${JSON.stringify(l.source)}`)
    .join('|');

  useEffect(() => {
    const geoLayers = layers.filter((l) => l.source.kind === 'geo-query');
    if (geoLayers.length === 0) {
      setResolved({});
      return;
    }
    const controller = new AbortController();
    let cancelled = false;

    Promise.all(
      geoLayers.map(async (layer) => {
        try {
          const rows = await fetchGeoQuery(layer, controller.signal);
          return [layer.id, rows] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, Record<string, unknown>[]> = {};
      for (const entry of entries) if (entry) next[entry[0]] = entry[1];
      setResolved(next);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Intentionally keyed on `key` (the serialized geo-query layer set), not `layers`:
    // unrelated patches (opacity, viewport) must not trigger a refetch.
  }, [key]);

  return resolved;
}
