/**
 * Vector autoregression, for the one case Appendix C.3 allows it.
 *
 * > VAR is offered only for closed systems of three or more mutually causal
 * > nodes. ... VAR becomes available, and is suggested, the moment the analyst
 * > builds a causal cycle among three or more nodes, since at that point the
 * > system structure is something they actually asserted.
 *
 * So the rule lives in the entry point rather than in a comment:
 * `varForCycle` refuses a node set that is not a drawn cycle of at least three
 * nodes, and `suggestVar` is how a canvas finds the cycles that qualify. The
 * estimator underneath, `fitVar`, is ordinary least squares equation by
 * equation, which is the maximum-likelihood VAR under Gaussian errors.
 *
 * **What goes on an edge is the direct coefficient, not the impulse response.**
 * A VAR's impulse response at horizon h is the *system's* answer — every
 * feedback loop already folded in. `propagate` folds the loops in itself, so
 * an edge that carried an impulse response would have its feedback counted
 * twice. The edge from `a` to `b` at lag L carries `A_L[b][a]`, the response
 * of b to a holding the rest of the system's past fixed, and the tests check
 * that propagating the full set of direct coefficients reproduces the VAR's
 * own impulse response to rounding.
 *
 * The impulse response shown for reading is the **generalized** one (Pesaran
 * and Shin, 1998): a unit shock to one variable with the others moving as the
 * residual covariance says they do on such a day. The orthogonalized response
 * depends on a Cholesky ordering, which is one more piece of structure the
 * analyst never asserted.
 */

import type { CausalEdgeParams, EdgeID, NodeID } from '@picasso/canvas-core';
import { solve } from './linalg.js';
import { findCycles, type CausalLink } from './propagate.js';

export interface VarFit {
  variables: string[];
  lags: number;
  /** Rows used in each equation, after the first `lags` are spent as regressors. */
  observations: number;
  intercept: number[];
  /** `coefficients[l][i][j]`: equation `i` on variable `j` at lag `l + 1`. */
  coefficients: number[][][];
  /** OLS standard errors, the same shape. */
  standardErrors: number[][][];
  /** Residual covariance, divided by `observations - k * lags - 1`. */
  residualCovariance: number[][];
  rSquared: number[];
  /**
   * Spectral radius of the companion matrix. Below one the system settles
   * after a shock; at or above one it does not, and impulse responses from it
   * grow rather than describe anything.
   */
  spectralRadius: number;
  stable: boolean;
  warnings: string[];
}

export class VarNotOffered extends Error {
  constructor(readonly reason: string) {
    super(`a VAR is not offered here: ${reason}`);
    this.name = 'VarNotOffered';
  }
}

/** Fits a VAR(`lags`) with an intercept to equally long, aligned series. */
export function fitVar(series: Readonly<Record<string, readonly number[]>>, lags: number): VarFit {
  const variables = Object.keys(series);
  const k = variables.length;
  if (k === 0) throw new VarNotOffered('no series');
  if (!Number.isInteger(lags) || lags < 1) throw new VarNotOffered(`lags must be a positive integer, not ${lags}`);
  const length = (series[variables[0]!] ?? []).length;
  for (const name of variables) {
    if ((series[name] ?? []).length !== length) {
      throw new VarNotOffered(`"${name}" has ${(series[name] ?? []).length} observations and the others ${length}`);
    }
  }
  const columns = variables.map((name) => series[name] as readonly number[]);
  const regressors = 1 + k * lags;
  const observations = length - lags;
  if (observations <= regressors + 1) {
    throw new VarNotOffered(`${observations} usable observations for ${regressors} regressors per equation`);
  }

  // Shared design: [1, y_{t-1}, ..., y_{t-p}] for t = p .. T-1.
  const design: number[][] = [];
  for (let t = lags; t < length; t += 1) {
    const row = [1];
    for (let l = 1; l <= lags; l += 1) for (let j = 0; j < k; j += 1) row.push(columns[j]![t - l]!);
    design.push(row);
  }
  const xtx: number[][] = Array.from({ length: regressors }, () => new Array<number>(regressors).fill(0));
  for (const row of design) {
    for (let a = 0; a < regressors; a += 1) {
      for (let b = 0; b < regressors; b += 1) xtx[a]![b]! += row[a]! * row[b]!;
    }
  }
  // (X'X)^-1, column by column; its diagonal scales every equation's errors.
  const inverse: number[][] = [];
  for (let c = 0; c < regressors; c += 1) {
    const unit = new Array<number>(regressors).fill(0);
    unit[c] = 1;
    const column = solve(xtx.map((r) => [...r]), unit);
    if (!column) throw new VarNotOffered('the lagged series are collinear, so the system is not identified');
    inverse.push(column);
  }

  const intercept: number[] = [];
  const coefficients: number[][][] = Array.from({ length: lags }, () => Array.from({ length: k }, () => new Array<number>(k).fill(0)));
  const standardErrors: number[][][] = Array.from({ length: lags }, () => Array.from({ length: k }, () => new Array<number>(k).fill(0)));
  const residuals: number[][] = [];
  const rSquared: number[] = [];
  const dof = observations - regressors;

  for (let i = 0; i < k; i += 1) {
    const y = columns[i]!.slice(lags);
    const xty = new Array<number>(regressors).fill(0);
    for (let t = 0; t < observations; t += 1) {
      for (let a = 0; a < regressors; a += 1) xty[a]! += design[t]![a]! * y[t]!;
    }
    const beta = new Array<number>(regressors).fill(0);
    for (let a = 0; a < regressors; a += 1) {
      for (let b = 0; b < regressors; b += 1) beta[a]! += inverse[b]![a]! * xty[b]!;
    }
    const u = y.map((value, t) => value - design[t]!.reduce((sum, x, a) => sum + x * beta[a]!, 0));
    residuals.push(u);
    const ssr = u.reduce((sum, e) => sum + e * e, 0);
    const mean = y.reduce((sum, v) => sum + v, 0) / observations;
    const sst = y.reduce((sum, v) => sum + (v - mean) ** 2, 0);
    rSquared.push(sst === 0 ? 0 : 1 - ssr / sst);
    const s2 = ssr / dof;
    intercept.push(beta[0]!);
    for (let l = 0; l < lags; l += 1) {
      for (let j = 0; j < k; j += 1) {
        const a = 1 + l * k + j;
        coefficients[l]![i]![j] = beta[a]!;
        standardErrors[l]![i]![j] = Math.sqrt(Math.max(0, s2 * inverse[a]![a]!));
      }
    }
  }

  const residualCovariance = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => residuals[i]!.reduce((sum, e, t) => sum + e * residuals[j]![t]!, 0) / dof),
  );

  const spectralRadius = companionSpectralRadius(coefficients);
  const stable = spectralRadius < 1;
  const warnings: string[] = [];
  if (!stable) {
    warnings.push(
      `the fitted system is not stable (companion spectral radius ${spectralRadius.toFixed(3)}): a shock to it ` +
        'does not die out, so its impulse responses grow rather than describe a response.',
    );
  }
  return { variables, lags, observations, intercept, coefficients, standardErrors, residualCovariance, rSquared, spectralRadius, stable, warnings };
}

/** `MA` coefficients Psi_0 .. Psi_horizon of the fitted system. */
function movingAverage(fit: VarFit, horizon: number): number[][][] {
  const k = fit.variables.length;
  const identity = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
  const psi: number[][][] = [identity];
  for (let h = 1; h <= horizon; h += 1) {
    const next = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (let l = 1; l <= Math.min(h, fit.lags); l += 1) {
      const a = fit.coefficients[l - 1]!;
      const previous = psi[h - l]!;
      for (let i = 0; i < k; i += 1) {
        for (let j = 0; j < k; j += 1) {
          let sum = 0;
          for (let m = 0; m < k; m += 1) sum += a[i]![m]! * previous[m]![j]!;
          next[i]![j]! += sum;
        }
      }
    }
    psi.push(next);
  }
  return psi;
}

/**
 * Generalized impulse response: each variable's response, at horizons
 * 0..`horizon`, to a unit shock in `shock` with the other innovations moving
 * as the residual covariance implies. Ordering-free, unlike the Cholesky
 * response.
 */
export function generalizedResponse(fit: VarFit, shock: string, horizon: number): Record<string, number[]> {
  const j = fit.variables.indexOf(shock);
  if (j < 0) throw new VarNotOffered(`"${shock}" is not in the system`);
  const sigma = fit.residualCovariance;
  const impact = sigma.map((row) => row[j]! / sigma[j]![j]!);
  const psi = movingAverage(fit, horizon);
  const out: Record<string, number[]> = {};
  for (const [i, name] of fit.variables.entries()) {
    out[name] = psi.map((matrix) => matrix[i]!.reduce((sum, value, m) => sum + value * impact[m]!, 0));
  }
  return out;
}

/** Reduced-form impulse response: the response to a unit innovation in `shock` alone. */
export function reducedFormResponse(fit: VarFit, shock: string, horizon: number): Record<string, number[]> {
  const j = fit.variables.indexOf(shock);
  if (j < 0) throw new VarNotOffered(`"${shock}" is not in the system`);
  const psi = movingAverage(fit, horizon);
  const out: Record<string, number[]> = {};
  for (const [i, name] of fit.variables.entries()) out[name] = psi.map((matrix) => matrix[i]![j]!);
  return out;
}

/**
 * Spectral radius by Gelfand's formula, `lim ||C^n||^(1/n)`, over twelve
 * squarings (n = 4096), normalising at each so nothing overflows. Square roots
 * only: `rho = n0 * n1^(1/2) * n2^(1/4) * ...`, where each `n_i` is the norm
 * after the i-th squaring of the normalised matrix. The residual error is
 * about the matrix's conditioning to the power 1/4096: measured against a
 * two-variable system's eigenvalues, a relative 8.5e-5 — enough to say stable
 * or not, and reported to three places.
 */
function companionSpectralRadius(coefficients: number[][][]): number {
  const lags = coefficients.length;
  const k = coefficients[0]!.length;
  const size = k * lags;
  let m: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (let l = 0; l < lags; l += 1) {
    for (let i = 0; i < k; i += 1) for (let j = 0; j < k; j += 1) m[i]![l * k + j] = coefficients[l]![i]![j]!;
  }
  for (let i = k; i < size; i += 1) m[i]![i - k] = 1;

  const norm = (a: number[][]) => Math.sqrt(a.reduce((sum, row) => sum + row.reduce((s, v) => s + v * v, 0), 0));
  let radius = 1;
  for (let step = 0; step <= 12; step += 1) {
    if (step > 0) {
      const squared = Array.from({ length: size }, () => new Array<number>(size).fill(0));
      for (let i = 0; i < size; i += 1) {
        for (let p = 0; p < size; p += 1) {
          const left = m[i]![p]!;
          if (left === 0) continue;
          for (let j = 0; j < size; j += 1) squared[i]![j]! += left * m[p]![j]!;
        }
      }
      m = squared;
    }
    const n = norm(m);
    if (n === 0) return 0;
    let root = n;
    for (let r = 0; r < step; r += 1) root = Math.sqrt(root);
    radius *= root;
    m = m.map((row) => row.map((v) => v / n));
  }
  return radius;
}

/** Drawn cycles of three or more nodes: the systems C.3 offers a VAR for. */
export function suggestVar(links: readonly CausalLink[]): NodeID[][] {
  return findCycles(links).filter((cycle) => new Set(cycle).size >= 3);
}

export interface VarCycleInput {
  links: readonly CausalLink[];
  /** The nodes of a drawn cycle, in any order. */
  cycle: readonly NodeID[];
  /** One aligned series per node in the cycle. */
  series: ReadonlyMap<NodeID, readonly number[]>;
  /** Defaults to the longest lag drawn on the cycle's edges, and at least one. */
  lags?: number;
  /** The window the series cover, recorded on each edge. */
  window: readonly [string, string];
}

export interface VarCycleResult {
  fit: VarFit;
  /** The drawn edges, re-estimated: each carries its direct VAR coefficient. */
  links: CausalLink[];
  /** The same, as `CausalEdgeParams` to write back onto the document's edges. */
  params: Map<EdgeID, CausalEdgeParams>;
  /**
   * Direct coefficients the fit found that no drawn edge carries, with
   * |t| above 2 — including each node's own persistence. Reported, not added:
   * the analyst drew the map, and an edge the data suggests is a question for
   * them.
   */
  undrawn: { from: NodeID; to: NodeID; lag: number; elasticity: number; tStatistic: number }[];
}

/**
 * Estimates a drawn cycle as a VAR and writes the direct coefficients back
 * onto its edges.
 *
 * Refuses anything C.3 does not offer a VAR for: fewer than three nodes, or a
 * node set that is not a cycle the analyst drew. An edge with lag zero is
 * refused too — a reduced-form VAR has no contemporaneous coefficients, and a
 * same-period response is a local projection at horizon zero.
 */
export function varForCycle(input: VarCycleInput): VarCycleResult {
  const nodes = [...new Set(input.cycle)];
  if (nodes.length < 3) {
    throw new VarNotOffered(`${nodes.length} nodes; C.3 offers a VAR only for closed systems of three or more`);
  }
  const key = [...nodes].sort().join('|');
  const drawn = suggestVar(input.links).some((cycle) => [...new Set(cycle)].sort().join('|') === key);
  if (!drawn) {
    throw new VarNotOffered(`${nodes.join(', ')} do not form a cycle on the canvas; the system structure was not asserted`);
  }

  const inside = input.links.filter((l) => nodes.includes(l.from) && nodes.includes(l.to));
  const zero = inside.find((l) => l.lag === 0);
  if (zero) {
    throw new VarNotOffered(`edge ${zero.id} is contemporaneous; a VAR's coefficients are lagged, so estimate it by local projection`);
  }
  const lags = input.lags ?? Math.max(1, ...inside.map((l) => l.lag));
  const tooLong = inside.find((l) => l.lag > lags);
  if (tooLong) throw new VarNotOffered(`edge ${tooLong.id} has lag ${tooLong.lag}, beyond the ${lags} the system is fitted with`);

  const record: Record<string, readonly number[]> = {};
  for (const node of nodes) {
    const values = input.series.get(node);
    if (!values) throw new VarNotOffered(`no series for ${node}`);
    record[node] = values;
  }
  const fit = fitVar(record, lags);
  const index = (node: NodeID) => fit.variables.indexOf(node);

  const links = inside.map((link) => {
    const value = fit.coefficients[link.lag - 1]![index(link.to)]![index(link.from)]!;
    const se = fit.standardErrors[link.lag - 1]![index(link.to)]![index(link.from)]!;
    return {
      ...link,
      elasticity: value,
      method: 'var' as const,
      rSquared: fit.rSquared[index(link.to)]!,
      standardError: se,
    };
  });

  const undrawn: VarCycleResult['undrawn'] = [];
  for (let l = 0; l < lags; l += 1) {
    for (const to of nodes) {
      for (const from of nodes) {
        if (inside.some((link) => link.from === from && link.to === to && link.lag === l + 1)) continue;
        const value = fit.coefficients[l]![index(to)]![index(from)]!;
        const se = fit.standardErrors[l]![index(to)]![index(from)]!;
        const t = se > 0 ? value / se : 0;
        if (Math.abs(t) > 2) undrawn.push({ from, to, lag: l + 1, elasticity: value, tStatistic: t });
      }
    }
  }
  const params = new Map<EdgeID, CausalEdgeParams>(
    links.map((link) => [
      link.id,
      {
        sign: link.elasticity >= 0 ? 1 : -1,
        elasticity: link.elasticity,
        lagPeriods: link.lag,
        estimation: {
          method: 'var',
          window: [input.window[0], input.window[1]],
          r2: link.rSquared,
          se: link.standardError,
        },
      },
    ]),
  );
  return { fit, links, params, undrawn };
}
