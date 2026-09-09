/**
 * Shape pass (PRD 3.7, Appendix C.1).
 *
 * "A geometric recognizer (Rubine-style features plus corner detection)
 * classifies rectangles, ellipses, arrows, brackets, and lines." Appendix C.1
 * pins this layer as local, offline and model-free: pure TypeScript, 90ms p95,
 * always available. Handwriting recognition is the layer that needs a model;
 * this one must not.
 *
 * Each candidate scores in [0, 1] against explicit geometric criteria, and the
 * winner's confidence is discounted by how close the runner-up came. That
 * matters because the ambient promote affordance only appears above 0.85
 * (PRD 3.2.1): a stroke that is arguably two things should not offer to become
 * either one.
 */

import type { Vec2 } from '@picasso/canvas-core';
import { distance, perpendicularDistance } from './geometry.js';
import { extractFeatures, type StrokeFeatures } from './features.js';

export type ShapeKind = 'line' | 'rectangle' | 'ellipse' | 'arrow' | 'bracket' | 'unknown';

export interface Recognition {
  kind: ShapeKind;
  /** [0, 1]. Compare against SUGGESTION_CONFIDENCE_FLOOR before offering promotion. */
  confidence: number;
  /** Every candidate's raw score, for debugging a misclassification. */
  scores: Record<Exclude<ShapeKind, 'unknown'>, number>;
  features?: StrokeFeatures;
}

/** Below this the stroke is not any of the shapes we know. */
export const RECOGNITION_FLOOR = 0.55;

const UNRECOGNIZED: Recognition = {
  kind: 'unknown',
  confidence: 0,
  scores: { line: 0, rectangle: 0, ellipse: 0, arrow: 0, bracket: 0 },
};

/** Triangular falloff: 1 when value === ideal, 0 at ideal ± span. */
function near(value: number, ideal: number, span: number): number {
  return Math.max(0, 1 - Math.abs(value - ideal) / span);
}

/** 1 below `good`, falling to 0 at `bad`. */
function below(value: number, good: number, bad: number): number {
  if (value <= good) return 1;
  if (value >= bad) return 0;
  return 1 - (value - good) / (bad - good);
}

/** 1 above `good`, falling to 0 at `bad`. */
function above(value: number, good: number, bad: number): number {
  if (value >= good) return 1;
  if (value <= bad) return 0;
  return (value - bad) / (good - bad);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
}

export function recognizeShape(points: readonly Vec2[]): Recognition {
  const features = extractFeatures(points);
  if (!features) return UNRECOGNIZED;

  const scores = {
    line: scoreLine(features),
    rectangle: scoreRectangle(features),
    ellipse: scoreEllipse(features),
    arrow: scoreArrow(features),
    bracket: scoreBracket(features),
  };

  const ranked = (Object.entries(scores) as Array<[Exclude<ShapeKind, 'unknown'>, number]>)
    .sort((a, b) => b[1] - a[1]);
  const [winner, winnerScore] = ranked[0] as [Exclude<ShapeKind, 'unknown'>, number];
  const runnerUp = (ranked[1]?.[1] ?? 0);

  if (winnerScore < RECOGNITION_FLOOR) {
    return { kind: 'unknown', confidence: winnerScore, scores, features };
  }

  // An ambiguous stroke is not a confident one, however well it scored: a
  // rounded rectangle that is nearly an ellipse should not auto-offer either.
  const margin = Math.min(1, (winnerScore - runnerUp) / 0.25);
  const confidence = winnerScore * (0.72 + 0.28 * margin);

  return { kind: winner, confidence, scores, features };
}

function scoreLine(f: StrokeFeatures): number {
  // A drawn line wobbles, so straightness lands around 0.98 rather than 1.
  const straight = below(1 - f.straightness, 0.02, 0.14);
  const noCorners = f.sharpCorners.length === 0 ? 1 : 0;
  const littleTurning = below(f.turningAbsolute, 0.5, 2.2);
  return mean([straight, straight, noCorners, littleTurning]);
}

function scoreRectangle(f: StrokeFeatures): number {
  // Closure gates rather than votes. A bracket lies on its bounding box
  // perimeter, is axis aligned, and closes into a box-filling polygon, so it
  // out-scores on every other rectangle criterion; the one thing it is not is
  // closed. Without the gate, brackets read as rectangles.
  const closed = below(f.closure, 0.14, 0.45);
  if (closed === 0) return 0;

  // Fills its bounding box, unlike an ellipse (~0.785) or an open stroke.
  const fillsBox = near(f.areaRatio, 1, 0.32);
  const onPerimeter = near(f.perimeterCoverage, 1, 0.45);
  const aligned = f.axisAlignment;
  // Four corners, but a stroke that closes past its start can show five.
  const cornerCount = f.sharpCorners.length;
  const corners = cornerCount >= 3 && cornerCount <= 5 ? 1 : cornerCount === 2 ? 0.3 : 0;
  const notASliver = above(f.aspect, 0.08, 0);
  return closed * mean([fillsBox, onPerimeter, aligned, corners, corners, notASliver]);
}

function scoreEllipse(f: StrokeFeatures): number {
  const closed = below(f.closure, 0.14, 0.45);
  if (closed === 0) return 0;

  // Fit in the stroke's own principal frame: a tilted oval is still an oval.
  const fits = below(f.ellipseResidualOriented, 0.05, 0.22);
  // π/4 of the oriented box, which holds at any tilt.
  const area = near(f.areaRatioOriented, Math.PI / 4, 0.3);
  const smooth = f.sharpCorners.length === 0 ? 1 : f.sharpCorners.length === 1 ? 0.4 : 0;
  const oneLoop = near(f.turningAbsolute, 2 * Math.PI, Math.PI);
  return closed * mean([fits, fits, area, smooth, oneLoop]);
}

/**
 * A single-stroke arrow: a long shaft, then a sharp reversal into the head and
 * usually a second reversal back out of it. The head lives near the end of the
 * path and is short relative to the shaft.
 */
function scoreArrow(f: StrokeFeatures): number {
  const open = f.closure > 0.25 ? 1 : 0;
  if (open === 0) return 0;

  const n = f.samples.length;
  const head = f.sharpCorners.filter((c) => c.index > n * 0.4);
  if (head.length === 0) return 0;

  // The shaft is one straight run. A scribble that happens to end in a hook has
  // sharp corners all the way along it, and without this gate it scores as an
  // arrow: every false positive on the scribble set was one.
  if (f.sharpCorners.some((c) => c.index <= n * 0.4)) return 0;

  // An arrow covers its ground once. A wandering stroke doubles back.
  const compact = below(f.density, 2, 4);
  if (compact === 0) return 0;

  const firstHeadCorner = head[0] as { index: number; angle: number };
  // The shaft is what comes before the head, and it should dominate.
  const shaftFraction = firstHeadCorner.index / n;
  const shaftDominant = near(shaftFraction, 0.72, 0.42);

  // The head reverses hard: one big turn, often two.
  const reversal = mean(head.slice(0, 2).map((c) => below(2.6 - Math.abs(c.angle), 0, 1.5)));
  const headCount = head.length >= 2 ? 1 : 0.62;

  // The shaft itself is roughly straight, which is what separates an arrow
  // from a scribble that happens to end with a hook.
  const shaft = f.samples.slice(0, Math.max(2, firstHeadCorner.index));
  const shaftStraight = below(1 - straightnessOf(shaft), 0.04, 0.3);

  // The tip sits off the shaft line, and the stroke ends back near it.
  const tip = f.samples[firstHeadCorner.index] as Vec2;
  const last = f.samples[n - 1] as Vec2;
  const shaftStart = f.samples[0] as Vec2;
  const returnsToTip = below(distance(last, tip) / f.diagonal, 0.35, 0.85);
  const tipAtEnd = below(distance(tip, shaftStart) / f.diagonal, 0.95, 1.3);

  return compact * mean([shaftDominant, reversal, headCount, shaftStraight, shaftStraight, returnsToTip, tipAtEnd]);
}

/**
 * A bracket is three runs: a short arm, a long spine, a short arm, with both
 * arms on the same side of the spine.
 */
function scoreBracket(f: StrokeFeatures): number {
  if (f.closure < 0.25) return 0;
  const corners = f.sharpCorners;
  if (corners.length !== 2) return 0;

  // Two corners joined by straight runs turn through about two right angles.
  // A flat zigzag can present two dominant corners and otherwise look bracket
  // shaped, but it wanders far more than that on the way; measured on the
  // synthetic set, real brackets top out near 7.2 radians.
  const tidy = below(f.turningAbsolute, 7.5, 11);
  if (tidy === 0) return 0;

  const n = f.samples.length;
  const [a, b] = corners as [{ index: number; angle: number }, { index: number; angle: number }];
  // Both corners turn the same way: that is what makes it a bracket rather
  // than a Z or a staircase.
  const sameSense = Math.sign(a.angle) === Math.sign(b.angle) ? 1 : 0;
  if (sameSense === 0) return 0;

  const spineFraction = (b.index - a.index) / n;
  const spineDominant = near(spineFraction, 0.6, 0.45);
  const armsBalanced = 1 - Math.min(1, Math.abs(a.index - (n - b.index)) / (n * 0.5));

  // Right-angle-ish turns.
  const squareness = mean([a, b].map((c) => near(Math.abs(c.angle), Math.PI / 2, 0.9)));

  // Arms reach across the spine's normal, so the shape has depth.
  const arms = mean([
    below(1 - straightnessOf(f.samples.slice(0, a.index + 1)), 0.05, 0.4),
    below(1 - straightnessOf(f.samples.slice(b.index)), 0.05, 0.4),
  ]);

  // Both arms on the same side of the spine line.
  const spineStart = f.samples[a.index] as Vec2;
  const spineEnd = f.samples[b.index] as Vec2;
  const armTipStart = f.samples[0] as Vec2;
  const armTipEnd = f.samples[n - 1] as Vec2;
  const sideStart = sideOf(armTipStart, spineStart, spineEnd);
  const sideEnd = sideOf(armTipEnd, spineStart, spineEnd);
  const sameSide = sideStart * sideEnd > 0 ? 1 : 0;
  // Arms have to reach away from the spine, or this is just a wobbly line.
  const armDepth = mean([
    above(perpendicularDistance(armTipStart, spineStart, spineEnd) / f.diagonal, 0.12, 0),
    above(perpendicularDistance(armTipEnd, spineStart, spineEnd) / f.diagonal, 0.12, 0),
  ]);

  return tidy * mean([spineDominant, armsBalanced, squareness, arms, sameSide, sameSide, armDepth]);
}

function straightnessOf(points: readonly Vec2[]): number {
  if (points.length < 2) return 1;
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += distance(points[i - 1] as Vec2, points[i] as Vec2);
  }
  if (length === 0) return 1;
  return distance(points[0] as Vec2, points[points.length - 1] as Vec2) / length;
}

function sideOf(p: Vec2, a: Vec2, b: Vec2): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
