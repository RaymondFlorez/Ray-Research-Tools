/**
 * Stroke features (PRD 3.7, shape pass).
 *
 * Rubine-style: reduce a stroke to a small vector of scale- and
 * rotation-tolerant numbers, then classify on those. Computing them once and
 * handing them to the classifier keeps the rules readable and makes a
 * misclassification debuggable — the recognition result carries the features
 * that produced it.
 */

import type { Rect, Vec2 } from '@picasso/canvas-core';
import {
  axisAlignment,
  bounds,
  convexHull,
  detectCorners,
  distance,
  ellipseResidual,
  orientedBoxArea,
  orientedEllipseResidual,
  pathLength,
  perimeterCoverage,
  polygonArea,
  principalAxes,
  rectArea,
  rectDiagonal,
  resample,
  smoothPath,
  totalAbsoluteTurning,
  totalSignedTurning,
  type Corner,
} from './geometry.js';

/** Samples every feature is computed on. */
export const RESAMPLE_COUNT = 64;

export interface StrokeFeatures {
  /** Arc-length resampled path the classifier works on. */
  samples: Vec2[];
  box: Rect;
  diagonal: number;
  pathLength: number;
  /** Shorter box side over longer. 1 is square, near 0 is a sliver. */
  aspect: number;
  /** Endpoint gap over box diagonal. Small means the stroke closes. */
  closure: number;
  /** Endpoint distance over path length. 1 is a perfectly straight stroke. */
  straightness: number;
  corners: Corner[];
  /** Corners with a turn sharp enough to be deliberate. */
  sharpCorners: Corner[];
  turningAbsolute: number;
  turningSigned: number;
  /** Stroke-as-polygon area over box area. ~1 rectangle, ~0.785 ellipse. */
  areaRatio: number;
  /** Convex hull area over box area. Low means a concave or open stroke. */
  hullRatio: number;
  ellipseResidual: number;
  /** Ellipse fit in the stroke's own principal frame, so tilt does not matter. */
  ellipseResidualOriented: number;
  /** Stroke area over its oriented box area. ~0.785 for an ellipse at any tilt. */
  areaRatioOriented: number;
  perimeterCoverage: number;
  axisAlignment: number;
  /** Path length over box diagonal. High means the stroke doubles back a lot. */
  density: number;
}

/** A turn this sharp reads as a deliberate corner rather than a curve. */
export const SHARP_CORNER_RADIANS = 1.15;

export function extractFeatures(points: readonly Vec2[]): StrokeFeatures | undefined {
  if (points.length < 3) return undefined;

  const length = pathLength(points);
  const box = bounds(points);
  const diagonal = rectDiagonal(box);
  if (length === 0 || diagonal === 0) return undefined;

  // Smoothing is not cosmetic: tremor on a resampled path reads as corners.
  const samples = smoothPath(resample(points, RESAMPLE_COUNT));
  const first = samples[0] as Vec2;
  const last = samples[samples.length - 1] as Vec2;
  const endpointGap = distance(first, last);

  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  const corners = detectCorners(samples);

  const boxArea = Math.max(1e-9, rectArea(box));
  const oriented = principalAxes(samples);
  const strokeArea = polygonArea(samples);

  return {
    samples,
    box,
    diagonal,
    pathLength: length,
    aspect: Math.min(width, height) / Math.max(1e-9, Math.max(width, height)),
    closure: endpointGap / diagonal,
    straightness: endpointGap / length,
    corners,
    sharpCorners: corners.filter((c) => Math.abs(c.angle) >= SHARP_CORNER_RADIANS),
    turningAbsolute: totalAbsoluteTurning(samples),
    turningSigned: totalSignedTurning(samples),
    areaRatio: strokeArea / boxArea,
    hullRatio: polygonArea(convexHull(samples)) / boxArea,
    ellipseResidual: ellipseResidual(samples, box),
    ellipseResidualOriented: orientedEllipseResidual(samples, oriented),
    areaRatioOriented: strokeArea / Math.max(1e-9, orientedBoxArea(oriented)),
    perimeterCoverage: perimeterCoverage(samples, box),
    axisAlignment: axisAlignment(samples),
    density: length / diagonal,
  };
}
