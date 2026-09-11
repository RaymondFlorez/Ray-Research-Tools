/**
 * @picasso/canvas-pricing
 *
 * The bridge between the Rust pricing core and the canvas: the WASM module
 * loaded and typed, the scalar and grid surfaces, and the StrategyNode that
 * computes through them.
 *
 * Nothing here does arithmetic. The PRD requires client and server to agree bit
 * for bit (7.1), and the only way to keep that true is for the browser to run
 * the same compiled code the server does rather than a JavaScript translation
 * of it.
 */

export * from './module.js';
export * from './pricing.js';
export * from './grid.js';
export * from './strategy.js';
