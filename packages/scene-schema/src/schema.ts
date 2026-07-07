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

export const LayerTypeSchema = z.enum(['geojson', 'polygon', 'scatterplot', 'heatmap', 'arc']);

/** Where a layer's data comes from. Extended in Step 4 (@geoglobe/layer-adapters). */
export const LayerSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('geojson'), url: z.string().min(1) }),
  z.object({
    kind: z.literal('geo-query'),
    dataset: z.string().min(1),
    filter: z.record(z.string(), z.unknown()).optional(),
  }),
]);

/** Visual encoding. Open-ended (passthrough) but common fields are typed. */
export const EncodingSchema = z
  .object({
    fill: RgbaSchema.optional(),
    line: RgbaSchema.optional(),
    lineWidthMinPixels: z.number().nonnegative().optional(),
    radius: z.union([z.number(), z.string()]).optional(),
    color: z.object({ field: z.string(), scale: z.string() }).optional(),
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
