import { describe, expect, it } from 'vitest';
import type { Layer } from '@geoglobe/scene-schema';
import { buildLayerSpec } from './spec';

function layer(partial: Partial<Layer> & Pick<Layer, 'id' | 'type' | 'source'>): Layer {
  return {
    encoding: {},
    visible: true,
    opacity: 1,
    ...partial,
  } as Layer;
}

describe('buildLayerSpec — geojson', () => {
  it('maps a geojson polygon layer to a GeoJsonLayer', () => {
    const spec = buildLayerSpec(
      layer({
        id: 'countries',
        type: 'geojson',
        source: { kind: 'geojson', url: '/data/countries.geojson' },
        encoding: { fill: [1, 2, 3, 4], line: [5, 6, 7, 8], lineWidthMinPixels: 0.5 },
      }),
    );
    expect(spec.type).toBe('GeoJsonLayer');
    expect(spec.props.data).toBe('/data/countries.geojson');
    expect(spec.props.getFillColor).toEqual([1, 2, 3, 4]);
    expect(spec.props.visible).toBe(true);
  });
});

describe('buildLayerSpec — scatterplot', () => {
  const base = layer({
    id: 'cities',
    type: 'scatterplot',
    source: { kind: 'json', url: '/data/cities.json' },
    encoding: { position: ['lng', 'lat'], radius: 'pop', radiusScale: 0.02 },
  });

  it('builds position and sqrt-scaled radius accessors', () => {
    const spec = buildLayerSpec(base);
    expect(spec.type).toBe('ScatterplotLayer');
    const getPosition = spec.props.getPosition as (d: Record<string, unknown>) => [number, number];
    expect(getPosition({ lng: 10, lat: 20 })).toEqual([10, 20]);
    const getRadius = spec.props.getRadius as (d: Record<string, unknown>) => number;
    expect(getRadius({ pop: 10000 })).toBeCloseTo(Math.sqrt(10000) * 0.02);
  });

  it('applies a data-driven color ramp when encoding.color is set', () => {
    const spec = buildLayerSpec(
      layer({
        id: 'cities',
        type: 'scatterplot',
        source: { kind: 'json', url: '/data/cities.json' },
        encoding: { color: { field: 'pop', scale: 'plasma', domain: [0, 100] } },
      }),
    );
    const getFillColor = spec.props.getFillColor as (d: Record<string, unknown>) => number[];
    expect(getFillColor({ pop: 0 })).toEqual([13, 8, 135, 255]);
  });

  it('wires an attribute filter through getFilterValue + filterRange', () => {
    const spec = buildLayerSpec(
      layer({
        id: 'cities',
        type: 'scatterplot',
        source: { kind: 'json', url: '/data/cities.json' },
        encoding: { filterField: 'pop', filterRange: [1_000_000, 1e9] },
      }),
    );
    expect(spec.props.filterSize).toBe(1);
    expect(spec.props.filterRange).toEqual([1_000_000, 1e9]);
    const getFilterValue = spec.props.getFilterValue as (d: Record<string, unknown>) => number;
    expect(getFilterValue({ pop: 5_000_000 })).toBe(5_000_000);
  });
});

describe('buildLayerSpec — heatmap + time filter', () => {
  it('builds a HeatmapLayer with a weight accessor', () => {
    const spec = buildLayerSpec(
      layer({
        id: 'heat',
        type: 'heatmap',
        source: { kind: 'json', url: '/data/cities.json' },
        encoding: { weight: 'pop' },
      }),
    );
    expect(spec.type).toBe('HeatmapLayer');
    const getWeight = spec.props.getWeight as (d: Record<string, unknown>) => number;
    expect(getWeight({ pop: 42 })).toBe(42);
  });

  it('encodes a time filter as a 0/1 filter value', () => {
    const spec = buildLayerSpec(
      layer({
        id: 'quakes',
        type: 'scatterplot',
        source: { kind: 'json', url: '/data/quakes.json' },
        encoding: { timeField: 'time' },
      }),
      { timeRange: ['2026-01-01', '2026-06-30'] },
    );
    expect(spec.props.filterSize).toBe(1);
    const getFilterValue = spec.props.getFilterValue as (d: Record<string, unknown>) => number;
    expect(getFilterValue({ time: '2026-03-01' })).toBe(1);
    expect(getFilterValue({ time: '2026-09-01' })).toBe(0);
  });
});

describe('buildLayerSpec — column', () => {
  it('builds a ColumnLayer with an elevation accessor', () => {
    const spec = buildLayerSpec(
      layer({
        id: 'bars',
        type: 'column',
        source: { kind: 'json', url: '/data/cities.json' },
        encoding: {
          position: ['lng', 'lat'],
          elevation: 'pop',
          elevationScale: 0.01,
          radiusMeters: 25000,
        },
      }),
    );
    expect(spec.type).toBe('ColumnLayer');
    expect(spec.props.radius).toBe(25000);
    expect(spec.props.extruded).toBe(true);
    const getElevation = spec.props.getElevation as (d: Record<string, unknown>) => number;
    expect(getElevation({ pop: 5000 })).toBe(5000);
  });
});

describe('buildLayerSpec — tile sources', () => {
  it('maps a raster source to a raster TileLayer', () => {
    const spec = buildLayerSpec(
      layer({
        id: 'sat',
        type: 'geojson',
        source: { kind: 'raster', url: 'https://x/{z}/{x}/{y}.png' },
      }),
    );
    expect(spec.type).toBe('TileLayer');
    expect(spec.raster).toBe(true);
  });

  it('maps a vector-tile source to an MVTLayer', () => {
    const spec = buildLayerSpec(
      layer({
        id: 'mvt',
        type: 'polygon',
        source: { kind: 'vector-tile', url: 'https://x/{z}/{x}/{y}.mvt' },
      }),
    );
    expect(spec.type).toBe('MVTLayer');
  });
});

describe('buildLayerSpec — geo-query resolution', () => {
  const quakeLayer = layer({
    id: 'earthquakes',
    type: 'scatterplot',
    source: { kind: 'geo-query', dataset: 'earthquakes' },
  });

  it('throws for an unresolved geo-query source', () => {
    expect(() => buildLayerSpec(quakeLayer)).toThrow(/geo-query/);
  });

  it('uses injected resolvedData for a geo-query layer', () => {
    const rows = [{ lng: 1, lat: 2, mag: 5 }];
    const spec = buildLayerSpec(quakeLayer, { resolvedData: { earthquakes: rows } });
    expect(spec.type).toBe('ScatterplotLayer');
    expect(spec.props.data).toBe(rows);
  });
});
