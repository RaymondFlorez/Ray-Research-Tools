// @geoglobe/layer-adapters
//
// Converts canonical Scene State layers into deck.gl layers. The mapping logic
// (spec.ts, scales.ts, time.ts) is pure and unit-tested; instantiate.ts is the thin
// deck.gl-facing shim used by the renderer.

export const LAYER_ADAPTERS_VERSION = '0.1.0';

export * from './scales';
export * from './time';
export * from './spec';
export * from './instantiate';
