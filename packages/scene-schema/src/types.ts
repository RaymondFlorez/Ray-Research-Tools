import type { z } from 'zod';
import type {
  AnnotationSchema,
  EncodingSchema,
  LayerSchema,
  LayerSourceSchema,
  LayerTypeSchema,
  SceneStateSchema,
  SelectionSchema,
  TimeStateSchema,
  ViewportSchema,
} from './schema';

/**
 * Compile-time types derived from the Zod schemas so validation and typing never drift.
 * `z.infer` yields the *output* type (post-defaults), which is what consumers hold.
 */
export type Viewport = z.infer<typeof ViewportSchema>;
export type TimeState = z.infer<typeof TimeStateSchema>;
export type LayerType = z.infer<typeof LayerTypeSchema>;
export type LayerSource = z.infer<typeof LayerSourceSchema>;
export type Encoding = z.infer<typeof EncodingSchema>;
export type Layer = z.infer<typeof LayerSchema>;
export type Selection = z.infer<typeof SelectionSchema>;
export type Annotation = z.infer<typeof AnnotationSchema>;
export type SceneState = z.infer<typeof SceneStateSchema>;
