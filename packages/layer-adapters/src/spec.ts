import type { Encoding, Layer, LayerSource } from '@geoglobe/scene-schema';
import { makeColorAccessor, type RGBA } from './scales';
import { withinTime, type TimeRange } from './time';

/**
 * A deck.gl layer described as plain data: which deck layer class to build and the
 * props (including accessor functions) to build it with. Keeping this pure — no deck.gl
 * import — means the entire mapping is unit-testable in Node without WebGL.
 * `instantiate.ts` turns a spec into a real deck.gl layer.
 */
export type DeckLayerType =
  'GeoJsonLayer' | 'ScatterplotLayer' | 'ColumnLayer' | 'HeatmapLayer' | 'MVTLayer' | 'TileLayer';

export interface DeckLayerSpec {
  type: DeckLayerType;
  props: Record<string, unknown>;
  /** TileLayer with a raster image sublayer (instantiate attaches the BitmapLayer). */
  raster?: boolean;
}

export interface BuildOptions {
  currentTime?: string | null;
  timeRange?: TimeRange;
  /**
   * Data already fetched for a layer id (e.g. a `geo-query` layer resolved by the
   * backend). When present it is used directly instead of the source URL, which is how
   * geo-query layers become renderable on the client.
   */
  resolvedData?: Record<string, unknown>;
}

const DEFAULT_FILL: RGBA = [58, 78, 110, 210];
const DEFAULT_LINE: RGBA = [126, 156, 204, 255];
const DEFAULT_POINT: RGBA = [90, 170, 240, 220];

type Datum = Record<string, unknown>;

/** Resolve a data URL from URL-bearing sources; other kinds are handled elsewhere. */
function urlSource(source: LayerSource): string {
  if (source.kind === 'geojson' || source.kind === 'json') return source.url;
  if (source.kind === 'geo-query') {
    throw new Error(`geo-query sources are resolved by the Data Service (Step 5), not the adapter`);
  }
  throw new Error(`Source kind '${source.kind}' has no direct data URL`);
}

/** Data for a layer: injected (already-fetched) data wins over a source URL. */
function resolveData(layer: Layer, opts: BuildOptions): unknown {
  const injected = opts.resolvedData?.[layer.id];
  if (injected !== undefined) return injected;
  return urlSource(layer.source);
}

function positionAccessor(encoding: Encoding): (d: Datum) => [number, number] {
  const [lngField, latField] = encoding.position ?? ['lng', 'lat'];
  return (d) => [Number(d[lngField]), Number(d[latField])];
}

/** Radius in pixels: a constant, or sqrt-scaled from a numeric field (area ∝ value). */
function radiusAccessor(encoding: Encoding): number | ((d: Datum) => number) {
  const { radius, radiusScale = 1 } = encoding;
  if (radius == null) return 4;
  if (typeof radius === 'number') return radius;
  return (d) => Math.sqrt(Math.max(0, Number(d[radius]))) * radiusScale;
}

function weightAccessor(encoding: Encoding): number | ((d: Datum) => number) {
  const { weight } = encoding;
  if (weight == null) return 1;
  if (typeof weight === 'number') return weight;
  return (d) => Number(d[weight]) || 0;
}

function elevationAccessor(encoding: Encoding): number | ((d: Datum) => number) {
  const { elevation } = encoding;
  if (elevation == null) return 1000;
  if (typeof elevation === 'number') return elevation;
  return (d) => Number(d[elevation]) || 0;
}

/** Fill color: a data-driven ramp if `encoding.color` is set, else a static color. */
function fillColor(encoding: Encoding, fallback: RGBA): RGBA | ((d: Datum) => RGBA) {
  if (encoding.color) {
    const domain = encoding.color.domain ?? [0, 1];
    return makeColorAccessor(encoding.color.field, encoding.color.scale, domain);
  }
  return encoding.fill ?? fallback;
}

/**
 * Attach a client-side attribute filter (population, magnitude, …) and/or a time filter
 * as a single `getFilterValue` + `filterRange`, wired to deck's DataFilterExtension in
 * instantiate.ts. filterSize adapts to how many dimensions are active.
 */
function applyFilters(
  props: Record<string, unknown>,
  encoding: Encoding,
  opts: BuildOptions,
): void {
  const attr = encoding.filterField
    ? { field: encoding.filterField, range: encoding.filterRange ?? [-Infinity, Infinity] }
    : null;
  const timeActive = Boolean(encoding.timeField && (opts.currentTime || opts.timeRange));

  if (!attr && !timeActive) return;

  const timeField = encoding.timeField;
  const range = opts.timeRange ?? null;
  const current = opts.currentTime ?? null;

  if (attr && timeActive && timeField) {
    props.getFilterValue = (d: Datum) => [
      Number(d[attr.field]),
      withinTime(d[timeField] as string, range, current) ? 1 : 0,
    ];
    props.filterRange = [attr.range, [1, 1]];
    props.filterSize = 2;
  } else if (attr) {
    props.getFilterValue = (d: Datum) => Number(d[attr.field]);
    props.filterRange = attr.range;
    props.filterSize = 1;
  } else if (timeField) {
    props.getFilterValue = (d: Datum) =>
      withinTime(d[timeField] as string, range, current) ? 1 : 0;
    props.filterRange = [1, 1];
    props.filterSize = 1;
  }
}

/** Map a canonical Scene State `Layer` to a deck.gl layer spec. */
export function buildLayerSpec(layer: Layer, opts: BuildOptions = {}): DeckLayerSpec {
  const common = {
    id: layer.id,
    visible: layer.visible,
    opacity: layer.opacity,
    pickable: true,
  };

  // Tile sources are dispatched by source kind, regardless of the nominal layer type.
  if (layer.source.kind === 'raster') {
    return { type: 'TileLayer', raster: true, props: { ...common, data: layer.source.url } };
  }
  if (layer.source.kind === 'vector-tile') {
    return {
      type: 'MVTLayer',
      props: {
        ...common,
        data: layer.source.url,
        getFillColor: layer.encoding.fill ?? DEFAULT_FILL,
        getLineColor: layer.encoding.line ?? DEFAULT_LINE,
        lineWidthMinPixels: layer.encoding.lineWidthMinPixels ?? 0.5,
      },
    };
  }

  switch (layer.type) {
    case 'geojson':
    case 'polygon': {
      return {
        type: 'GeoJsonLayer',
        props: {
          ...common,
          data: resolveData(layer, opts),
          stroked: true,
          filled: true,
          getFillColor: fillColor(layer.encoding, DEFAULT_FILL),
          getLineColor: layer.encoding.line ?? DEFAULT_LINE,
          lineWidthMinPixels: layer.encoding.lineWidthMinPixels ?? 0.5,
        },
      };
    }
    case 'scatterplot': {
      const props: Record<string, unknown> = {
        ...common,
        data: resolveData(layer, opts),
        getPosition: positionAccessor(layer.encoding),
        getRadius: radiusAccessor(layer.encoding),
        radiusUnits: 'pixels',
        radiusMinPixels: layer.encoding.radiusMinPixels ?? 1,
        radiusMaxPixels: layer.encoding.radiusMaxPixels ?? 60,
        getFillColor: fillColor(layer.encoding, DEFAULT_POINT),
      };
      applyFilters(props, layer.encoding, opts);
      return { type: 'ScatterplotLayer', props };
    }
    case 'column': {
      const props: Record<string, unknown> = {
        ...common,
        data: resolveData(layer, opts),
        getPosition: positionAccessor(layer.encoding),
        getElevation: elevationAccessor(layer.encoding),
        elevationScale: layer.encoding.elevationScale ?? 1,
        radius: layer.encoding.radiusMeters ?? 20_000,
        radiusUnits: 'meters',
        diskResolution: 12,
        extruded: true,
        getFillColor: fillColor(layer.encoding, DEFAULT_POINT),
      };
      applyFilters(props, layer.encoding, opts);
      return { type: 'ColumnLayer', props };
    }
    case 'heatmap': {
      // NOTE: deck.gl's HeatmapLayer is an aggregation layer that supports only the Web
      // Mercator MapView, not GlobeView. Fully wired + unit-tested here; it renders on a
      // flat map. On the globe, prefer 'column' or 'scatterplot' for density.
      const props: Record<string, unknown> = {
        ...common,
        data: resolveData(layer, opts),
        getPosition: positionAccessor(layer.encoding),
        getWeight: weightAccessor(layer.encoding),
        radiusPixels: 40,
        intensity: 1,
        threshold: 0.05,
      };
      applyFilters(props, layer.encoding, opts);
      return { type: 'HeatmapLayer', props };
    }
    case 'arc':
      // ArcLayer (origin→destination flows) is out of scope for Step 4.
      throw new Error(`Layer type 'arc' is not implemented yet`);
    default: {
      const _never: never = layer.type;
      throw new Error(`Unsupported layer type: ${String(_never)}`);
    }
  }
}
