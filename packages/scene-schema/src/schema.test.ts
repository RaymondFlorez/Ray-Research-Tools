import { describe, expect, it } from 'vitest';
import { LayerSchema, SceneStateSchema, ViewportSchema } from './schema';

describe('ViewportSchema', () => {
  it('applies pitch/bearing defaults', () => {
    const vp = ViewportSchema.parse({ longitude: 10, latitude: 20, zoom: 2 });
    expect(vp.pitch).toBe(0);
    expect(vp.bearing).toBe(0);
  });

  it('rejects out-of-range longitude', () => {
    expect(ViewportSchema.safeParse({ longitude: 999, latitude: 0, zoom: 1 }).success).toBe(false);
  });
});

describe('LayerSchema', () => {
  it('applies visible/opacity defaults and discriminates the source union', () => {
    const layer = LayerSchema.parse({
      id: 'quakes',
      type: 'scatterplot',
      source: { kind: 'geo-query', dataset: 'earthquakes', filter: { mag: { gte: 4.5 } } },
    });
    expect(layer.visible).toBe(true);
    expect(layer.opacity).toBe(1);
    expect(layer.source.kind).toBe('geo-query');
  });

  it('rejects an unknown source kind', () => {
    const bad = LayerSchema.safeParse({
      id: 'x',
      type: 'geojson',
      source: { kind: 'mystery' },
    });
    expect(bad.success).toBe(false);
  });
});

describe('SceneStateSchema', () => {
  it('parses the ARCHITECTURE §5 example scene', () => {
    const scene = SceneStateSchema.parse({
      viewport: { longitude: -98, latitude: 39, zoom: 3, pitch: 0, bearing: 0 },
      time: { current: '2026-06-01T00:00Z', range: ['2026-01-01', '2026-06-30'] },
      layers: [
        {
          id: 'quakes',
          type: 'scatterplot',
          source: { kind: 'geo-query', dataset: 'earthquakes', filter: { mag: { gte: 4.5 } } },
          encoding: { radius: 'mag', color: { field: 'depth', scale: 'viridis' } },
          visible: true,
          opacity: 0.9,
        },
      ],
      selection: { layerId: 'quakes', featureIds: ['us7000'] },
      annotations: [],
    });
    expect(scene.layers).toHaveLength(1);
    expect(scene.selection?.featureIds).toEqual(['us7000']);
  });
});
