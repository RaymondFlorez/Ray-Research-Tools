/**
 * @picasso/canvas-gl
 *
 * The WebGL2 path: a Scene draw list becomes two instanced draw calls, so node
 * count stops costing draw calls. This is what the PRD's 5,000-nodes-at-60fps
 * target rests on, and what the DOM path cannot do past a few hundred nodes.
 */

export * from './instances.js';
export * from './shaders.js';
export * from './renderer.js';
