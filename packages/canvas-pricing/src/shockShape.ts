/**
 * The shape of a rate shock, estimated from history (PRD 5.7).
 *
 * > apply a 50bps shock with a selectable shape, defaulting to a
 * > historically-estimated shape conditional on a hawkish surprise rather than
 * > a naive parallel move ... Note what the second plan does that a naive
 * > implementation would not: it refuses to pretend a parallel shift is the
 * > honest default, and it exposes the estimation quality of every mapping it
 * > uses.
 *
 * The estimate is an event study on the curve. For each standard tenor, the
 * event-day yield change is regressed on the policy surprise that day (from
 * fed funds futures, say — the caller supplies it), over **hawkish** events
 * only: a curve does not have to respond to a hawkish surprise the way it
 * responds to a dovish one, and pooling them gives the average of two shapes,
 * which is neither. Each tenor's loading carries its standard error, R² and
 * event count.
 *
 * The shape is each loading divided by the anchor tenor's — the point the
 * "50bps" is quoted at — so the anchor moves exactly as asked and every other
 * tenor moves by its estimated multiple. The ratio's standard error is the
 * delta method with the two equations' residual covariance, because the
 * loadings share a regressor and their errors are correlated.
 */

import { STANDARD_TENORS, type DrawnShock } from './curve.js';

export interface CurveEvent {
  date: string;
  /** The policy surprise, in bp. Positive is hawkish. */
  surprise: number;
  /** Yield changes on the day, in bp, at each of `tenors`. */
  changes: readonly number[];
}

export interface TenorLoading {
  tenor: number;
  /** bp of yield change per bp of surprise. */
  loading: number;
  standardError: number;
  rSquared: number;
  /** This tenor's multiple of the anchor's move. */
  shape: number;
  shapeStandardError: number;
}

export interface ShockShapeEstimate {
  anchor: number;
  /** Hawkish events the shape rests on. */
  events: number;
  loadings: TenorLoading[];
  /** One line per tenor whose fit should not be leaned on. */
  assumptions: string[];
}

export class ShapeNotEstimable extends Error {
  constructor(readonly reason: string) {
    super(`the shock shape cannot be estimated: ${reason}`);
    this.name = 'ShapeNotEstimable';
  }
}

/** Fewer hawkish events than this and the shape is refused rather than shown. */
export const MIN_SHAPE_EVENTS = 8;
/** Below this R², a tenor's loading is named as an assumption. */
export const WEAK_SHAPE_R2 = 0.2;

export interface ShapeOptions {
  /** The tenor the shock size is quoted at. Three months — the policy end — by default. */
  anchor?: number;
  tenors?: readonly number[];
  /**
   * `'hawkish'` (the default) estimates on positive surprises only;
   * `'pooled'` uses every event, for comparison.
   */
  condition?: 'hawkish' | 'pooled';
}

/** Estimates the curve's response to a policy surprise, tenor by tenor. */
export function estimateShockShape(events: readonly CurveEvent[], options: ShapeOptions = {}): ShockShapeEstimate {
  const tenors = options.tenors ?? STANDARD_TENORS;
  const anchor = options.anchor ?? 0.25;
  const a = tenors.indexOf(anchor);
  if (a < 0) throw new ShapeNotEstimable(`the anchor ${anchor}y is not one of the tenors`);
  for (const event of events) {
    if (event.changes.length !== tenors.length) {
      throw new ShapeNotEstimable(`${event.date} has ${event.changes.length} changes for ${tenors.length} tenors`);
    }
  }
  const used = (options.condition ?? 'hawkish') === 'hawkish' ? events.filter((e) => e.surprise > 0) : [...events];
  const n = used.length;
  if (n < MIN_SHAPE_EVENTS) {
    throw new ShapeNotEstimable(`${n} ${options.condition === 'pooled' ? '' : 'hawkish '}events; at least ${MIN_SHAPE_EVENTS} are needed`);
  }

  // One regressor plus an intercept, shared by every tenor's equation.
  const x = used.map((e) => e.surprise);
  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const sxx = x.reduce((s, v) => s + (v - meanX) ** 2, 0);
  if (sxx === 0) throw new ShapeNotEstimable('every event has the same surprise, so no slope is identified');

  const fits = tenors.map((_, t) => {
    const y = used.map((e) => e.changes[t]!);
    const meanY = y.reduce((s, v) => s + v, 0) / n;
    const beta = x.reduce((s, v, i) => s + (v - meanX) * (y[i]! - meanY), 0) / sxx;
    const alpha = meanY - beta * meanX;
    const residuals = y.map((v, i) => v - alpha - beta * x[i]!);
    const sst = y.reduce((s, v) => s + (v - meanY) ** 2, 0);
    const ssr = residuals.reduce((s, e) => s + e * e, 0);
    return { beta, residuals, rSquared: sst === 0 ? 0 : 1 - ssr / sst };
  });

  const dof = n - 2;
  const covariance = (i: number, j: number) =>
    fits[i]!.residuals.reduce((s, e, k) => s + e * fits[j]!.residuals[k]!, 0) / dof;
  const anchorFit = fits[a]!;
  if (anchorFit.beta === 0) throw new ShapeNotEstimable(`the ${anchor}y tenor does not respond to the surprise`);

  const loadings = tenors.map((tenor, t) => {
    const fit = fits[t]!;
    const varBeta = covariance(t, t) / sxx;
    const varAnchor = covariance(a, a) / sxx;
    const cov = covariance(t, a) / sxx;
    const shape = fit.beta / anchorFit.beta;
    // Delta method on beta_t / beta_a.
    const shapeVar = (varBeta - 2 * shape * cov + shape * shape * varAnchor) / (anchorFit.beta * anchorFit.beta);
    return {
      tenor,
      loading: fit.beta,
      standardError: Math.sqrt(Math.max(0, varBeta)),
      rSquared: fit.rSquared,
      shape: t === a ? 1 : shape,
      shapeStandardError: t === a ? 0 : Math.sqrt(Math.max(0, shapeVar)),
    };
  });

  const assumptions = loadings
    .filter((l) => l.rSquared < WEAK_SHAPE_R2)
    .map(
      (l) =>
        `${l.tenor}y: the surprise explains ${(l.rSquared * 100).toFixed(0)}% of its event-day moves over ${n} events, ` +
        `so its ${l.shape.toFixed(2)}x multiple is closer to an assumption than an estimate`,
    );
  return { anchor, events: n, loadings, assumptions };
}

/**
 * The shock itself: `bps` at the anchor, every other tenor at its estimated
 * multiple. Every tenor is given explicitly, so nothing is left to the
 * engine's flat extrapolation.
 */
export function shockFromShape(estimate: ShockShapeEstimate, bps: number): DrawnShock {
  return {
    shape: 'custom',
    points: [...estimate.loadings]
      .sort((p, q) => p.tenor - q.tenor)
      .map((l) => ({ tenor: l.tenor, bps: bps * l.shape })),
  };
}
