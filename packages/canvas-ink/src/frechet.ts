/**
 * The sketch-to-code verifier (PRD 3.7).
 *
 * > **Sketch-to-code.** A drawn payoff diagram, a scribbled formula, or a
 * > hand-drawn causal loop converts to a `CodeNode` or a `CausalNode` cluster.
 * > The generating model must emit code that compiles and produces the
 * > sketched shape within tolerance; a verifier node re-renders the produced
 * > payoff and compares against the ink geometry (Fréchet distance under
 * > threshold) before the proposal is offered.
 *
 * The model is the part this repository does not have. The verifier is the
 * part that makes the model safe to have, and it is deterministic, so it is
 * here.
 *
 * ## Fréchet, because order matters
 *
 * The obvious comparison — how far is each ink point from the nearest point of
 * the rendered curve — is the Hausdorff distance, and it cannot tell a long
 * straddle from a V drawn the other way round, or a curve that visits the same
 * places in a different order. Fréchet distance couples the two curves in
 * order, start to end, and is the smallest leash that lets a walker on each
 * traverse both without either stepping back. It is computed on the discrete
 * form (Eiter and Mannila, 1994) after both curves are resampled evenly by arc
 * length, so a slow passage of ink does not count more than a fast one.
 *
 * ## Shape, not scale; but never mirror
 *
 * Nobody draws a payoff to scale: the analyst draws a hockey stick and means
 * "long call", not "long call worth exactly this many pixels". So both curves
 * are mapped to the unit square by their own bounding boxes before comparison.
 * What the normalization must *not* do is forgive a reflection — a short call
 * is a long call upside down, and a verifier that normalized that away would
 * pass the one error that loses money fastest. Which way is up on the ink is
 * therefore a required argument: screen coordinates grow downward, a P&L axis
 * grows upward, and a default either way is a default that is wrong for half
 * the callers.
 *
 * ## Direction of drawing is not a mirror
 *
 * A payoff diagram is read left to right, and whether the analyst's hand moved
 * left to right is not part of what they drew. A stroke drawn right to left is
 * reversed before comparison, so a correct sketch is not rejected for the
 * direction the pen travelled.
 */

import type { Vec2 } from '@picasso/canvas-core';
import { resample } from './geometry.js';

/**
 * Discrete Fréchet distance between two polylines.
 *
 * The Eiter-Mannila recurrence, bottom-up with a rolling row so memory is
 * linear in the second curve. Tested against a brute-force enumeration of
 * every coupling on small inputs.
 */
export function discreteFrechet(a: readonly Vec2[], b: readonly Vec2[]): number {
  if (a.length === 0 || b.length === 0) return Number.NaN;
  const d = (i: number, j: number) => Math.hypot(a[i]!.x - b[j]!.x, a[i]!.y - b[j]!.y);
  let previous = new Array<number>(b.length);
  let current = new Array<number>(b.length);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const here = d(i, j);
      if (i === 0 && j === 0) current[j] = here;
      else if (i === 0) current[j] = Math.max(current[j - 1]!, here);
      else if (j === 0) current[j] = Math.max(previous[0]!, here);
      else current[j] = Math.max(Math.min(previous[j]!, previous[j - 1]!, current[j - 1]!), here);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length - 1]!;
}

/**
 * Maps a curve into the unit square by its own bounding box.
 *
 * A curve with no height — a flat payoff, a flat stroke — keeps its aspect
 * rather than being stretched: its vertical extent is scaled by its width, so
 * a flat line stays flat and centred instead of becoming a vertical smear of
 * floating-point noise.
 */
export function normalizeToUnit(points: readonly Vec2[]): Vec2[] {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const width = maxX - minX || 1;
  const rawHeight = maxY - minY;
  const flat = rawHeight <= width * 1e-9;
  const height = flat ? width : rawHeight;
  const offset = flat ? 0.5 : 0;
  return points.map((p) => ({ x: (p.x - minX) / width, y: (p.y - minY) / height + offset }));
}

/** Points per curve after arc-length resampling. */
export const VERIFY_SAMPLES = 96;

/**
 * Fréchet distance in the unit square, below which a rendered payoff matches
 * the sketch.
 *
 * Set between two measured clusters in `test/frechet.test.ts`. Fifty
 * hand-drawn long calls — tremor, a misplaced kink, a slope that is not
 * quite one — score 0.016 to 0.072 against the true long call. The nearest
 * wrong shape, a bull call spread whose cap is the only thing that tells it
 * apart, scores 0.210 to 0.228 against the same strokes; a short put 0.43 and
 * up; a short call, a long put and a straddle close to 1. The threshold sits in
 * the gap between the first two clusters, which is narrower than the rest and
 * is the one to watch if the tolerance is ever moved.
 */
export const PAYOFF_TOLERANCE = 0.15;

export interface PayoffSketchInput {
  /** The ink, as captured. */
  ink: readonly Vec2[];
  /**
   * Which way the ink's y axis points. Required: screen coordinates grow
   * downward and a P&L axis grows upward, and getting it wrong turns every
   * long position into a short one that verifies perfectly.
   */
  inkYAxis: 'down' | 'up';
  /** The rendered payoff: P&L (up) against spot, in spot order. */
  payoff: readonly Vec2[];
  tolerance?: number;
}

export interface PayoffVerdict {
  distance: number;
  tolerance: number;
  /** The proposal may be offered. */
  matches: boolean;
}

export function verifyPayoffSketch(input: PayoffSketchInput): PayoffVerdict {
  const tolerance = input.tolerance ?? PAYOFF_TOLERANCE;
  if (input.ink.length < 2 || input.payoff.length < 2) {
    return { distance: Number.POSITIVE_INFINITY, tolerance, matches: false };
  }
  let ink = input.inkYAxis === 'down' ? input.ink.map((p) => ({ x: p.x, y: -p.y })) : [...input.ink];
  // Read left to right, whichever way the pen went.
  if (ink[ink.length - 1]!.x < ink[0]!.x) ink = ink.reverse();
  const payoff = [...input.payoff].sort((a, b) => a.x - b.x);
  const a = resample(normalizeToUnit(ink), VERIFY_SAMPLES);
  const b = resample(normalizeToUnit(payoff), VERIFY_SAMPLES);
  const distance = discreteFrechet(a, b);
  return { distance, tolerance, matches: distance <= tolerance };
}

export class SketchNotVerified extends Error {
  constructor(readonly verdict: PayoffVerdict) {
    super(
      `the generated payoff is ${verdict.distance.toFixed(3)} from the sketch against a tolerance of ` +
        `${verdict.tolerance}: it does not draw what was drawn, and is not offered`,
    );
    this.name = 'SketchNotVerified';
  }
}

export interface CodeProposal<T> {
  /** What the generator produced: code, a leg list, whatever the caller runs. */
  candidate: T;
  verdict: PayoffVerdict;
}

/**
 * The only way a sketch-to-code candidate becomes an offer.
 *
 * "Before the proposal is offered" is the order, so the verification happens
 * here and a candidate that fails it never reaches the analyst — not as a
 * greyed-out option, not with a warning. An offer that has to be read
 * carefully to discover it is wrong is the failure the verifier exists for.
 */
export function offerPayoffProposal<T>(candidate: T, input: PayoffSketchInput): CodeProposal<T> {
  const verdict = verifyPayoffSketch(input);
  if (!verdict.matches) throw new SketchNotVerified(verdict);
  return { candidate, verdict };
}
