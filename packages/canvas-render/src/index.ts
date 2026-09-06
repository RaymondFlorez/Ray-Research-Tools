/**
 * @picasso/canvas-render
 *
 * Scene assembly for the Picasso canvas: LOD bucketing, DOM mount lifecycle,
 * edge geometry, binding visual signatures and the passive-mode wash. Emits a
 * draw list rather than pixels, so the WebGL layer, the DOM layer and the tests
 * all consume the same output.
 */

export * from './theme.js';
export * from './style.js';
export * from './edges.js';
export * from './wash.js';
export * from './mount.js';
export * from './scene.js';
