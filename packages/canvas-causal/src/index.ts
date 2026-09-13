/**
 * @picasso/canvas-causal
 *
 * The causal layer from PRD 5.6: elasticities estimated by local projection
 * with Newey-West errors, a regime split that cannot be hidden, and shock
 * propagation over a graph that is allowed to have cycles.
 *
 * The thread running through all of it is PRD 5.6's own sentence: "the map is
 * falsifiable. Every edge is an empirical claim, and Picasso will happily tell
 * the analyst that the elasticity they asserted has an R-squared of 0.04 over
 * their chosen window."
 */

export * from './estimate.js';
export * from './regime.js';
export * from './propagate.js';
export * from './edge.js';
