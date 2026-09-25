/**
 * The ink-to-curve recognizer (PRD 5.3).
 *
 * > **Scenario shocks:** parallel, steepener, flattener, butterfly, and
 * > arbitrary user-drawn curve shapes. The analyst can literally draw the
 * > shocked curve with the pen and the ink-to-curve recognizer converts the
 * > stroke to tenor-point deltas.
 *
 * The conversion is a coordinate change and an interpolation, and everything
 * interesting is in what it refuses to do with a gesture.
 *
 * ## A curve is a function of tenor, and a stroke is not
 *
 * A hand moving left to right across a chart traces one rate per tenor. A hand
 * that hesitates, backs up, or crosses itself traces two, and there is no
 * reading of the second that is not a guess about which one the analyst meant.
 * Taking the last sample, or the mean, or the topmost, each looks reasonable
 * and each silently invents a shock. So a stroke that is not monotonic in
 * tenor is refused by name, and the analyst redraws — which costs a second and
 * is the only thing that recovers their actual intent.
 *
 * A small backward wobble is not a reversal, though: pen jitter at the start
 * and end of a stroke routinely moves a pixel the wrong way, and refusing on
 * that would make the tool unusable. The tolerance is stated in pixels rather
 * than in data units, because it is a property of the hand and the digitizer.
 *
 * ## A tenor the stroke did not cover has no delta
 *
 * The obvious convenience is to extend the first and last samples flat to the
 * ends of the axis. That writes a shock the analyst did not draw — worse, a
 * *zero* one, which in a curve shock means "held here", the strongest claim on
 * the chart. `Shock` already distinguishes absent from zero, and this keeps
 * that true: uncovered tenors are listed and left out.
 *
 * ## The reading is as accurate as the sampling, and no more
 *
 * A stroke is a sequence of samples and the rate between two of them is
 * interpolated, so a kink in the underlying curve that falls between two
 * samples is read across rather than through. At 120Hz over a thirty-year axis
 * that is worth about a basis point at a pin sitting on a kink — the same order
 * as the rounding below, and the reason both are stated rather than either
 * being presented as exact.
 *
 * ## The result is rounded to the pen's own precision
 *
 * A stroke sampled at 120Hz over a few hundred pixels resolves the rate axis
 * to something like a basis point. Reporting 47.3bp from a gesture implies a
 * precision the hand does not have, and a number with a decimal point in it
 * gets copied into a note and then into a conversation. Deltas come back in
 * whole basis points and `resolutionBps` says what one pixel was worth, so an
 * analyst who drew on a cramped chart can see it.
 */

import type { Shock, Vec2 } from '@picasso/canvas-core';
import { strokePoints, type InkStroke } from './stroke.js';

/**
 * The chart the stroke was drawn on.
 *
 * Tenor runs along x and rate along y, both linear. `yAtRate` and `xAtTenor`
 * are the same mapping the chart used to draw the existing curve, supplied
 * rather than reconstructed: a recognizer that rebuilt the transform from the
 * axis labels would disagree with the renderer at the edges, and the analyst
 * would be drawing on one chart and shocking another.
 */
export interface CurveFrame {
  /** Screen or world x for a tenor in years. Must be increasing in tenor. */
  xAtTenor: (tenor: number) => number;
  /** Screen or world y for a rate in decimal. */
  yAtRate: (rate: number) => number;
  /** The inverse of `yAtRate`. */
  rateAtY: (y: number) => number;
}

/** A tenor on the curve's axis, with the rate it currently carries. */
export interface CurvePin {
  /** The label the shock is keyed by: `2Y`, `10Y`. */
  label: string;
  /** Years. */
  tenor: number;
  /** The current zero rate, in decimal. */
  rate: number;
}

export class StrokeIsNotACurve extends Error {
  constructor(
    readonly reason: 'not_monotonic' | 'too_short',
    detail: string,
  ) {
    super(`this stroke cannot be read as a curve: ${detail}`);
    this.name = 'StrokeIsNotACurve';
  }
}

export interface CurveReading {
  /** The shock, ready for a ScenarioNode. Only covered tenors appear. */
  shock: Shock & { kind: 'curve' };
  /** Tenors the stroke did not span, named rather than filled in. */
  uncovered: string[];
  /** What one pixel of the rate axis was worth, in basis points. */
  resolutionBps: number;
  /** Where the stroke started and ended, in years. */
  span: { from: number; to: number };
}

/** Backward movement smaller than this is pen jitter, not a reversal. */
export const JITTER_PX = 2;

/**
 * Read a drawn stroke as a set of tenor-point deltas.
 *
 * The delta at a tenor is the rate the analyst drew there less the rate the
 * curve already carries, so drawing straight over the existing curve produces
 * a shock of zero everywhere it covers — which is the property that makes the
 * gesture legible. A shock that came back non-zero for a traced line would
 * mean the recognizer and the renderer disagree about where the curve is.
 */
export function strokeToCurveShock(
  stroke: InkStroke,
  frame: CurveFrame,
  pins: readonly CurvePin[],
  currency: string,
  jitterPx = JITTER_PX,
): CurveReading {
  const points = strokePoints(stroke);
  if (points.length < 2) {
    throw new StrokeIsNotACurve('too_short', `it has ${points.length} sample(s)`);
  }

  assertMonotonic(points, jitterPx);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const from = first.x;
  const to = last.x;

  const tenorDeltasBps: Record<string, number> = {};
  const uncovered: string[] = [];
  for (const pin of pins) {
    const x = frame.xAtTenor(pin.tenor);
    if (x < from || x > to) {
      uncovered.push(pin.label);
      continue;
    }
    const y = interpolateY(points, x);
    const drawn = frame.rateAtY(y);
    // Whole basis points: the pen does not resolve tenths, and a number with a
    // decimal point gets copied into a note and then into a conversation.
    const bps = Math.round((drawn - pin.rate) * 10_000);
    // A rounded-down-from-nothing is `-0`, which serializes as `-0` and reads
    // as a negative move of zero. There is no such move.
    tenorDeltasBps[pin.label] = bps === 0 ? 0 : bps;
  }

  return {
    shock: { kind: 'curve', currency, tenorDeltasBps },
    uncovered,
    resolutionBps: resolution(frame),
    span: { from, to },
  };
}

/**
 * One basis point of the rate axis, in pixels, inverted.
 *
 * Measured from the frame rather than assumed, because the analyst may have
 * drawn on a chart two inches tall.
 */
function resolution(frame: CurveFrame): number {
  const perPixel = Math.abs(frame.rateAtY(1) - frame.rateAtY(0));
  return perPixel * 10_000;
}

function assertMonotonic(points: readonly Vec2[], jitterPx: number): void {
  let high = points[0]!.x;
  for (const [index, point] of points.entries()) {
    if (point.x >= high) {
      high = point.x;
      continue;
    }
    if (high - point.x <= jitterPx) continue;
    throw new StrokeIsNotACurve(
      'not_monotonic',
      `it doubles back by ${(high - point.x).toFixed(1)}px at sample ${index}, so two rates ` +
        'sit on one tenor and nothing here can tell which one you meant',
    );
  }
}

/**
 * The drawn y at an x, linearly between the two samples bracketing it.
 *
 * The scan is linear because a stroke is a few hundred samples and this runs
 * once per tenor pin — a dozen times — when the pen lifts. A binary search here
 * would be faster in a way nobody could measure and wrong in a way somebody
 * eventually would: the samples are monotonic only to within the jitter
 * tolerance above, and a search assumes strict order.
 */
function interpolateY(points: readonly Vec2[], x: number): number {
  let best = points[0]!;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (x < Math.min(a.x, b.x) || x > Math.max(a.x, b.x)) {
      if (Math.abs(b.x - x) < Math.abs(best.x - x)) best = b;
      continue;
    }
    const span = b.x - a.x;
    if (span === 0) return (a.y + b.y) / 2;
    const weight = (x - a.x) / span;
    return a.y + weight * (b.y - a.y);
  }
  return best.y;
}

/**
 * How the shock reads in words, for the affordance shown before it is applied.
 *
 * PRD 3.2: nothing auto-promotes. A drawn curve is a proposal, and the analyst
 * confirms it — so the proposal has to be readable at a glance, which a map of
 * twelve integers is not.
 */
export function describeCurveShock(reading: CurveReading): string {
  const entries = Object.entries(reading.shock.tenorDeltasBps);
  if (entries.length === 0) return 'this stroke does not cross any tenor on the curve';
  const moves = entries.map(([label, bps]) => `${label} ${bps >= 0 ? '+' : ''}${bps}bp`);
  const covered = `${moves.join(', ')}`;
  return reading.uncovered.length === 0
    ? covered
    : `${covered} (${reading.uncovered.join(', ')} not drawn, and left alone)`;
}

/**
 * The reading as the tenor points a curve engine applies.
 *
 * The one place "left alone" has to be said out loud. The reading keeps an
 * undrawn tenor *absent*, which is right for a scenario: absent composes with
 * another shock and zero does not. But an engine applying a shock to a curve
 * needs a value at every tenor, and `pricing-core` holds the end values flat
 * beyond the last point it is given — so a stroke that stopped at 12y, handed
 * over as-is, moves 30y by whatever was drawn at 10y. The description the
 * analyst confirmed said 30y was left alone.
 *
 * So every undrawn pin is written as an explicit zero here. Between the last
 * drawn pin and the first undrawn one the engine interpolates, which is a
 * taper nobody drew; it is the smallest invention that keeps every pin the
 * analyst did not touch exactly where it was, and `README` names it.
 */
export function engineShockPoints(
  reading: CurveReading,
  pins: readonly CurvePin[],
): Array<{ tenor: number; bps: number }> {
  return [...pins]
    .sort((a, b) => a.tenor - b.tenor)
    .map((pin) => ({ tenor: pin.tenor, bps: reading.shock.tenorDeltasBps[pin.label] ?? 0 }));
}
