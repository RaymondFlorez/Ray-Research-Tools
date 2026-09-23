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
export * from './curve.js';
export * from './bonds.js';
export * from './monteCarlo.js';
export * from './heston.js';
export * from './curveNode.js';
export * from './transmission.js';
export * from './scenario.js';
export * from './strategy.js';
export * from './risk.js';
