import { z } from 'zod';

/**
 * Canonical Scene State schema — the serializable "visual database" contract from
 * ARCHITECTURE.md §5. The client renders exclusively from a value of this shape, and
 * the LLM agent (Step 7) reads it and mutates it via validated JSON Patches (patch.ts).
 *
 * Types are derived from these schemas (see types.ts) so the runtime validator and the
 * compile-time types can never drift.
 */

export const RgbaSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** Camera pose. Ranges are validated so a bad patch can't put the camera off-globe. */
export const ViewportSchema = z.object({
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  zoom: z.number().min(-2).max(24),
  pitch: z.number().min(0).max(90).default(0),
  bearing: z.number().default(0),
});

/** Time cursor + window. ISO-8601 strings; null when the scene is time-agnostic. */
export const TimeStateSchema = z.object({
  current: z.string().nullable().default(null),
  range: z.tuple([z.string(), z.string()]).nullable().default(null),
});

export const LayerTypeSchema = z.enum([
  'geojson',
  'polygon',
  'scatterplot',
  'column',
  'heatmap',
  'arc',
]);

/**
 * Where a layer's data comes from. `@geoglobe/layer-adapters` maps each kind to a
 * deck.gl layer:
 *  - geojson     → FeatureCollection URL (polygons/lines/points)
 *  - json        → URL to a flat array of records (points; scatterplot/heatmap)
 *  - geo-query   → backend Data Service query (Step 5)
 *  - vector-tile → MVT tile template URL (Step 5/11)
 *  - raster      → raster tile template URL (basemap/imagery)
 */
export const LayerSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('geojson'), url: z.string().min(1) }),
  z.object({ kind: z.literal('json'), url: z.string().min(1) }),
  z.object({
    kind: z.literal('geo-query'),
    dataset: z.string().min(1),
    filter: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ kind: z.literal('vector-tile'), url: z.string().min(1) }),
  z.object({ kind: z.literal('raster'), url: z.string().min(1) }),
]);

/** Visual encoding. Open-ended (passthrough) but common fields are typed. */
export const EncodingSchema = z
  .object({
    fill: RgbaSchema.optional(),
    line: RgbaSchema.optional(),
    lineWidthMinPixels: z.number().nonnegative().optional(),
    /** Radius in pixels: a constant, or a data field name to scale by. */
    radius: z.union([z.number(), z.string()]).optional(),
    radiusScale: z.number().positive().optional(),
    radiusMinPixels: z.number().nonnegative().optional(),
    radiusMaxPixels: z.number().nonnegative().optional(),
    /** Color ramp driven by a data field. */
    color: z
      .object({
        field: z.string(),
        scale: z.string(),
        domain: z.tuple([z.number(), z.number()]).optional(),
      })
      .optional(),
    /** Heatmap weight: a constant, or a data field name. */
    weight: z.union([z.number(), z.string()]).optional(),
    /** Column extrusion (3-D bars): height from a constant or field, plus scale/radius. */
    elevation: z.union([z.number(), z.string()]).optional(),
    elevationScale: z.number().positive().optional(),
    radiusMeters: z.number().positive().optional(),
    /** For `json` point sources: [lngField, latField]. Defaults to ['lng','lat']. */
    position: z.tuple([z.string(), z.string()]).optional(),
    /** Field holding an ISO timestamp; enables the time filter for this layer. */
    timeField: z.string().optional(),
    /** Attribute filter: keep rows whose `filterField` value is within `filterRange`. */
    filterField: z.string().optional(),
    filterRange: z.tuple([z.number(), z.number()]).optional(),
  })
  .passthrough();

export const LayerSchema = z.object({
  id: z.string().min(1),
  type: LayerTypeSchema,
  source: LayerSourceSchema,
  encoding: EncodingSchema.default({}),
  visible: z.boolean().default(true),
  opacity: z.number().min(0).max(1).default(1),
});

export const SelectionSchema = z
  .object({
    layerId: z.string().min(1),
    featureIds: z.array(z.string()),
  })
  .nullable()
  .default(null);

export const AnnotationSchema = z.object({
  id: z.string().min(1),
  longitude: z.number().min(-180).max(180),
  latitude: z.number().min(-90).max(90),
  text: z.string(),
});

export const SceneStateSchema = z.object({
  viewport: ViewportSchema,
  time: TimeStateSchema.default({ current: null, range: null }),
  layers: z.array(LayerSchema).default([]),
  selection: SelectionSchema,
  annotations: z.array(AnnotationSchema).default([]),
});
