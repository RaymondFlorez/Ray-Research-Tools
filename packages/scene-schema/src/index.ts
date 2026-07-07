// @geoglobe/scene-schema
//
// Canonical Scene State: the serializable "visual database" contract (ARCHITECTURE §5).
// Exports the Zod schemas, their inferred types, and the immutable JSON Patch helper.

export const SCENE_SCHEMA_VERSION = '0.1.0';

export * from './schema';
export * from './types';
export * from './patch';
