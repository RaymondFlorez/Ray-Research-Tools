/**
 * @picasso/canvas-markets
 *
 * PRD 5.5 and 5.6: crypto market and on-chain series that wire into the same
 * nodes as everything else, prediction-market de-vigging routed by market type
 * (Appendix C.4), probability curves that cannot exist without their
 * resolution criteria, calibration scored against the market on the same
 * contracts, and probabilities carried into a scenario set as real weights.
 */

export * from './devig.js';
export * from './probability.js';
export * from './calibration.js';
export * from './weights.js';
export * from './chain.js';
