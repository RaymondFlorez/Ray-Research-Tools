/**
 * @picasso/canvas-sim
 *
 * PRD 5.8's simulation engine: event-driven backtests that cannot look ahead,
 * the detectors that run on every one of them, and the statistics that account
 * for how many strategies the analyst tried before this one.
 */

export * from './statistics.js';
export * from './pointInTime.js';
export * from './costs.js';
export * from './engine.js';
export * from './detectors.js';
