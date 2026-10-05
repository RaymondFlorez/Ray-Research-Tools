/**
 * `OptimizerNode` (PRD 3.3).
 *
 * The PRD names the node and defines nothing else: no objective, no inputs,
 * no constraints. Unlike the four scoring rubrics it names no house
 * methodology, so building one misrepresents nobody — but which objective is a
 * product decision, and the one taken (with the analyst's approval) is two
 * standard objectives over the Monte Carlo node's joint scenarios:
 *
 * - **mean-variance**: maximise `mu'w - (lambda/2) w'Sigma w`;
 * - **minimum CVaR**: minimise the expected loss in the worst `1 - alpha` of
 *   scenarios (Rockafellar and Uryasev), optionally subject to a target
 *   expected return.
 *
 * Both are long-only and fully invested, with an optional cap per asset.
 * Long-only and fully invested make gross exposure exactly one, so a gross
 * limit would never bind and is not offered; shorting is not offered either.
 *
 * ## The scenarios' measure is an assumption, and usually the binding one
 *
 * The Monte Carlo engine simulates under the risk-neutral measure: every asset
 * drifts at the risk-free rate. Expected returns read off those scenarios are
 * all the same number plus noise, so a mean-variance optimizer fed them has
 * nothing to trade off against variance and becomes a minimum-variance
 * optimizer that thinks it is doing more. `views` is how an analyst supplies
 * expected returns; without them the result says the means did not
 * distinguish the assets, measured rather than assumed.
 *
 * ## How each is solved, and checked
 *
 * Minimum CVaR is a linear program. Written out directly it has a variable
 * and a constraint per scenario; solved by cutting planes (Künzi-Bay and
 * Mayer, 2006) the master problem keeps one column per asset plus three and
 * gains one row per round, so it stays small at any scenario count. It
 * terminates exactly: when the master's bound on the tail sum equals the tail
 * sum at its own solution, nothing is left to cut.
 *
 * Mean-variance is a strictly convex quadratic program, solved by accelerated
 * projected gradient onto the capped simplex. Its result carries the KKT
 * residual, which is a certificate a test can check without trusting the
 * solver.
 */

import { createNode, type NodeID, type ParamValue, type PicassoNode, type Port, type Vec2 } from '@picasso/canvas-core';
import { solveLp, type Constraint } from './lp.js';

export interface ScenarioMatrix {
  assets: readonly string[];
  /** Each asset's level at the start, so a terminal level becomes a return. */
  spots: readonly number[];
  /** Row-major `paths × assets` terminal levels. */
  levels: ArrayLike<number>;
}

export type Objective =
  | { kind: 'mean_variance'; riskAversion: number }
  | { kind: 'min_cvar'; alpha: number; targetReturn?: number };

export interface OptimizerInput {
  scenarios: ScenarioMatrix;
  objective: Objective;
  /** Largest weight any one asset may take. Defaults to 1. */
  maxWeight?: number;
  /** Expected horizon returns per asset, replacing the scenario mean. */
  views?: Readonly<Record<string, number>>;
  /**
   * Where the scenarios came from, in words — "100k-path GBM under a t
   * copula, 0.35y". Required: an allocation without its scenario source is
   * an allocation nobody can audit.
   */
  source: string;
  /** Tail level the result's VaR and CVaR are reported at. Defaults to the objective's, or 0.95. */
  reportAlpha?: number;
}

export interface OptimizedWeight {
  asset: string;
  weight: number;
  /** `excluded` at zero, `capped` at `maxWeight`. */
  bound?: 'excluded' | 'capped';
}

export interface OptimizationResult {
  objective: Objective;
  weights: OptimizedWeight[];
  /** Horizon return, from views where given and scenario means otherwise. */
  expectedReturn: number;
  /** Standard deviation of the horizon return across scenarios. */
  volatility: number;
  /** Loss at the reporting tail level, as a positive fraction. */
  valueAtRisk: number;
  /** Mean loss beyond it, as a positive fraction. */
  conditionalValueAtRisk: number;
  reportAlpha: number;
  scenarioCount: number;
  /** Every input that shaped the answer, stated. */
  assumptions: string[];
  warnings: string[];
  diagnostics: { iterations: number; kktResidual?: number };
}

export class OptimizationRefused extends Error {
  constructor(readonly detail: string) {
    super(`optimization refused: ${detail}`);
    this.name = 'OptimizationRefused';
  }
}

/** Below this many scenarios in the tail, the CVaR is warned about. */
export const MIN_TAIL_SCENARIOS = 100;

interface Prepared {
  assets: readonly string[];
  /** Row-major `S × K` horizon returns. */
  returns: Float64Array;
  S: number;
  K: number;
  mu: number[];
  means: number[];
}

function prepare(input: OptimizerInput): Prepared {
  const { assets, spots, levels } = input.scenarios;
  const K = assets.length;
  if (K === 0) throw new OptimizationRefused('no assets');
  if (spots.length !== K) throw new OptimizationRefused(`${spots.length} spots for ${K} assets`);
  if (levels.length === 0 || levels.length % K !== 0) {
    throw new OptimizationRefused(`${levels.length} scenario values is not a whole number of rows of ${K}`);
  }
  if (input.source.trim() === '') throw new OptimizationRefused('the scenarios carry no source');
  const S = levels.length / K;
  const returns = new Float64Array(levels.length);
  for (let s = 0; s < S; s += 1) {
    for (let k = 0; k < K; k += 1) {
      const level = levels[s * K + k]!;
      if (!Number.isFinite(level)) throw new OptimizationRefused(`scenario ${s} has a non-finite level for ${assets[k]}`);
      returns[s * K + k] = level / spots[k]! - 1;
    }
  }
  const means = assets.map((_, k) => {
    let sum = 0;
    for (let s = 0; s < S; s += 1) sum += returns[s * K + k]!;
    return sum / S;
  });
  for (const name of Object.keys(input.views ?? {})) {
    if (!assets.includes(name)) throw new OptimizationRefused(`a view on ${name}, which is not among the assets`);
  }
  const mu = assets.map((a, k) => input.views?.[a] ?? means[k]!);
  return { assets, returns, S, K, mu, means };
}

/** Euclidean projection onto `{w : sum w = 1, 0 <= w <= cap}`, by bisection on the shift. */
export function projectCappedSimplex(v: readonly number[], cap: number): number[] {
  const total = (tau: number) => v.reduce((s, x) => s + Math.min(cap, Math.max(0, x - tau)), 0);
  let lo = Math.min(...v) - 1;
  let hi = Math.max(...v);
  for (let i = 0; i < 200 && hi - lo > 1e-15 * Math.max(1, Math.abs(hi)); i += 1) {
    const mid = 0.5 * (lo + hi);
    if (total(mid) > 1) lo = mid;
    else hi = mid;
  }
  const tau = 0.5 * (lo + hi);
  return v.map((x) => Math.min(cap, Math.max(0, x - tau)));
}

function covariance(p: Prepared): number[][] {
  const { returns, S, K, means } = p;
  const cov = Array.from({ length: K }, () => new Array<number>(K).fill(0));
  for (let s = 0; s < S; s += 1) {
    for (let i = 0; i < K; i += 1) {
      const di = returns[s * K + i]! - means[i]!;
      for (let j = i; j < K; j += 1) cov[i]![j]! += di * (returns[s * K + j]! - means[j]!);
    }
  }
  for (let i = 0; i < K; i += 1) {
    for (let j = i; j < K; j += 1) {
      cov[i]![j]! /= S - 1;
      cov[j]![i] = cov[i]![j]!;
    }
  }
  return cov;
}

/** KKT residual for `min (lambda/2) w'Sw - mu'w` over the capped simplex. */
export function kktResidual(w: readonly number[], cov: number[][], mu: readonly number[], lambda: number, cap: number): number {
  const g = w.map((_, i) => lambda * cov[i]!.reduce((s, c, j) => s + c * w[j]!, 0) - mu[i]!);
  const tol = 1e-9;
  const free = w.map((x, i) => (x > tol && x < cap - tol ? i : -1)).filter((i) => i >= 0);
  // The budget multiplier: the common gradient of the free coordinates, or
  // any value consistent with the bounds when none are free.
  const nu = free.length > 0 ? free.reduce((s, i) => s + g[i]!, 0) / free.length : g.reduce((a, b) => Math.min(a, b), Infinity);
  let residual = 0;
  w.forEach((x, i) => {
    if (x <= tol) residual = Math.max(residual, nu - g[i]!); // at zero: g_i >= nu
    else if (x >= cap - tol) residual = Math.max(residual, g[i]! - nu); // at cap: g_i <= nu
    else residual = Math.max(residual, Math.abs(g[i]! - nu));
  });
  return residual;
}

function meanVariance(p: Prepared, lambda: number, cap: number): { w: number[]; iterations: number; kkt: number } {
  const cov = covariance(p);
  const K = p.K;
  // A step of 1/L with L bounding lambda * ||Sigma||_2 (max absolute row sum).
  const L = lambda * Math.max(...cov.map((row) => row.reduce((s, c) => s + Math.abs(c), 0)));
  const grad = (w: number[]) => w.map((_, i) => lambda * cov[i]!.reduce((s, c, j) => s + c * w[j]!, 0) - p.mu[i]!);
  let w = projectCappedSimplex(new Array<number>(K).fill(1 / K), cap);
  if (!(L > 0)) return { w, iterations: 0, kkt: kktResidual(w, cov, p.mu, lambda, cap) };
  let y = [...w];
  let t = 1;
  let iterations = 0;
  for (; iterations < 200_000; iterations += 1) {
    const g = grad(y);
    const next = projectCappedSimplex(y.map((v, i) => v - g[i]! / L), cap);
    const tNext = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
    const momentum = (t - 1) / tNext;
    const change = Math.max(...next.map((v, i) => Math.abs(v - w[i]!)));
    y = next.map((v, i) => v + momentum * (v - w[i]!));
    w = next;
    t = tNext;
    if (change < 1e-14) break;
  }
  return { w, iterations, kkt: kktResidual(w, cov, p.mu, lambda, cap) };
}

function minCvar(p: Prepared, alpha: number, cap: number, target: number | undefined): { w: number[]; iterations: number } {
  const { K, S, returns } = p;
  const scale = 1 / ((1 - alpha) * S);
  // Variables: w_1..w_K, zeta+ , zeta-, theta.
  const width = K + 3;
  const objective = [...new Array<number>(K).fill(0), 1, -1, scale];
  const base: Constraint[] = [{ coefficients: [...new Array<number>(K).fill(1), 0, 0, 0], op: '=', rhs: 1 }];
  if (cap < 1) {
    for (let k = 0; k < K; k += 1) {
      const row = new Array<number>(width).fill(0);
      row[k] = 1;
      base.push({ coefficients: row, op: '<=', rhs: cap });
    }
  }
  if (target !== undefined) base.push({ coefficients: [...p.mu, 0, 0, 0], op: '>=', rhs: target });

  // theta >= sum over a subset of (L_s - zeta), with L_s = -r_s'w:
  // -(sum r_s)'w - |subset| zeta+ + |subset| zeta- - theta <= 0.
  const cut = (subset: number[]): Constraint => {
    const row = new Array<number>(width).fill(0);
    for (const s of subset) for (let k = 0; k < K; k += 1) row[k]! -= returns[s * K + k]!;
    row[K] = -subset.length;
    row[K + 1] = subset.length;
    row[K + 2] = -1;
    return { coefficients: row, op: '<=', rhs: 0 };
  };
  // The full set first: without it the master is unbounded in zeta.
  const cuts: Constraint[] = [cut(Array.from({ length: S }, (_, s) => s))];

  for (let iteration = 1; iteration <= 1_000; iteration += 1) {
    const solved = solveLp({ objective, constraints: [...base, ...cuts] });
    if (solved.status === 'infeasible') {
      throw new OptimizationRefused('no long-only, fully invested portfolio meets the target return under the cap');
    }
    if (solved.status !== 'optimal') throw new OptimizationRefused(`the CVaR master problem is ${solved.status}`);
    const w = solved.x.slice(0, K);
    const zeta = solved.x[K]! - solved.x[K + 1]!;
    const theta = solved.x[K + 2]!;
    const tail: number[] = [];
    let excess = 0;
    for (let s = 0; s < S; s += 1) {
      let loss = 0;
      for (let k = 0; k < K; k += 1) loss -= returns[s * K + k]! * w[k]!;
      if (loss > zeta) {
        tail.push(s);
        excess += loss - zeta;
      }
    }
    // The master's bound on the tail sum holds at its own solution: optimal.
    if (excess <= theta + 1e-10 * Math.max(1, Math.abs(theta))) return { w, iterations: iteration };
    cuts.push(cut(tail));
  }
  throw new OptimizationRefused('the cutting-plane method did not converge in 1,000 rounds');
}

/** VaR and Rockafellar-Uryasev CVaR of a loss sample, both as positive losses. */
export function tailRisk(losses: readonly number[], alpha: number): { valueAtRisk: number; conditionalValueAtRisk: number } {
  const sorted = [...losses].sort((a, b) => a - b);
  const S = sorted.length;
  const index = Math.min(S - 1, Math.max(0, Math.ceil(alpha * S) - 1));
  const zeta = sorted[index]!;
  let excess = 0;
  for (const loss of sorted) if (loss > zeta) excess += loss - zeta;
  return { valueAtRisk: zeta, conditionalValueAtRisk: zeta + excess / ((1 - alpha) * S) };
}

/** Optimises a long-only, fully invested portfolio over joint scenarios. */
export function optimizePortfolio(input: OptimizerInput): OptimizationResult {
  const p = prepare(input);
  const cap = input.maxWeight ?? 1;
  if (!(cap > 0 && cap <= 1)) throw new OptimizationRefused(`a weight cap of ${cap} is not in (0, 1]`);
  if (cap * p.K < 1 - 1e-12) {
    throw new OptimizationRefused(`${p.K} assets capped at ${cap} cannot add up to a fully invested portfolio`);
  }
  const objective = input.objective;
  const warnings: string[] = [];
  let w: number[];
  let diagnostics: OptimizationResult['diagnostics'];

  if (objective.kind === 'mean_variance') {
    if (!(objective.riskAversion > 0)) {
      throw new OptimizationRefused('risk aversion must be positive; at zero the problem is maximum return, which is a corner');
    }
    const solved = meanVariance(p, objective.riskAversion, cap);
    w = solved.w;
    diagnostics = { iterations: solved.iterations, kktResidual: solved.kkt };
  } else {
    if (!(objective.alpha > 0 && objective.alpha < 1)) throw new OptimizationRefused(`a tail level of ${objective.alpha} is not in (0, 1)`);
    const solved = minCvar(p, objective.alpha, cap, objective.targetReturn);
    w = solved.w;
    diagnostics = { iterations: solved.iterations };
  }

  const reportAlpha = input.reportAlpha ?? (objective.kind === 'min_cvar' ? objective.alpha : 0.95);
  const portfolio = Array.from({ length: p.S }, (_, s) => w.reduce((sum, x, k) => sum + x * p.returns[s * p.K + k]!, 0));
  const meanReturn = portfolio.reduce((a, b) => a + b, 0) / p.S;
  const volatility = Math.sqrt(portfolio.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / (p.S - 1));
  const tail = tailRisk(portfolio.map((r) => -r), reportAlpha);
  const tailCount = (1 - reportAlpha) * p.S;
  if (tailCount < MIN_TAIL_SCENARIOS) {
    warnings.push(`the ${(reportAlpha * 100).toFixed(1)}% tail holds ${Math.floor(tailCount)} of ${p.S} scenarios; its CVaR rests on few points`);
  }

  // Do the scenario means distinguish any two assets? A difference is
  // significant when it clears twice its standard error across scenarios.
  if (!input.views || Object.keys(input.views).length === 0) {
    let distinguished = false;
    for (let i = 0; i < p.K && !distinguished; i += 1) {
      for (let j = i + 1; j < p.K && !distinguished; j += 1) {
        let sum = 0;
        let sq = 0;
        for (let s = 0; s < p.S; s += 1) {
          const d = p.returns[s * p.K + i]! - p.returns[s * p.K + j]!;
          sum += d;
          sq += d * d;
        }
        const mean = sum / p.S;
        const se = Math.sqrt((sq / p.S - mean * mean) / (p.S - 1));
        if (Math.abs(mean) > 2 * se) distinguished = true;
      }
    }
    if (!distinguished && p.K > 1) {
      warnings.push(
        'no two assets\' scenario means differ by more than two standard errors, so the scenarios carry no return signal — ' +
          (objective.kind === 'mean_variance'
            ? 'mean-variance here is minimum variance. Supply views to give it one.'
            : 'a target return here constrains noise. Supply views to give it one.'),
      );
    }
  }

  const tol = 1e-9;
  const weights: OptimizedWeight[] = p.assets.map((asset, k) => ({
    asset,
    weight: w[k]!,
    ...(w[k]! <= tol ? { bound: 'excluded' as const } : w[k]! >= cap - tol ? { bound: 'capped' as const } : {}),
  }));
  const expectedReturn = w.reduce((s, x, k) => s + x * p.mu[k]!, 0);

  const assumptions = [
    `scenarios: ${p.S} joint outcomes from ${input.source.trim()}`,
    input.views && Object.keys(input.views).length > 0
      ? `expected returns: the analyst's views for ${Object.keys(input.views).join(', ')}; scenario means for the rest`
      : 'expected returns: scenario means — under a risk-neutral simulation every asset drifts at the risk-free rate',
    objective.kind === 'mean_variance'
      ? `objective: maximise expected return less ${objective.riskAversion}/2 times variance`
      : `objective: minimise the mean loss in the worst ${((1 - objective.alpha) * 100).toFixed(1)}% of scenarios` +
        (objective.targetReturn !== undefined ? `, subject to an expected return of at least ${objective.targetReturn}` : ''),
    `constraints: long-only, fully invested${cap < 1 ? `, at most ${cap} in any asset` : ''}`,
  ];

  return {
    objective,
    weights,
    expectedReturn,
    volatility,
    valueAtRisk: tail.valueAtRisk,
    conditionalValueAtRisk: tail.conditionalValueAtRisk,
    reportAlpha,
    scenarioCount: p.S,
    assumptions,
    warnings,
    diagnostics,
  };
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

/** Scenarios in, weights out. */
export function optimizerPorts(): { inputs: Port[]; outputs: Port[] } {
  return {
    inputs: [{ id: 'scenarios', name: 'Joint scenarios', type: 'distribution', cardinality: 'one', required: true }],
    outputs: [{ id: 'weights', name: 'Weights', type: 'portfolio', cardinality: 'one', required: false }],
  };
}

export interface OptimizerNodeInput {
  id: NodeID;
  objective: Objective;
  maxWeight?: number;
  views?: Readonly<Record<string, number>>;
  position?: Vec2;
}

export function createOptimizerNode(input: OptimizerNodeInput): PicassoNode {
  const ports = optimizerPorts();
  const params: Record<string, ParamValue> = { objective: { ...input.objective } };
  if (input.maxWeight !== undefined) params.maxWeight = input.maxWeight;
  if (input.views !== undefined) params.views = { ...input.views };
  return createNode({
    id: input.id,
    kind: 'OptimizerNode',
    binding: 'wired',
    position: input.position ?? { x: 0, y: 0 },
    size: { w: 320, h: 220 },
    inputs: ports.inputs,
    outputs: ports.outputs,
    params,
    nodeVersion: '1',
  });
}

/** Runs the node's params against the scenarios on its input port. */
export function evaluateOptimizerNode(node: PicassoNode, scenarios: ScenarioMatrix, source: string): OptimizationResult {
  if (node.kind !== 'OptimizerNode') throw new OptimizationRefused(`${node.id} is a ${node.kind}, not an OptimizerNode`);
  const params = node.params as unknown as { objective: Objective; maxWeight?: number; views?: Record<string, number> };
  return optimizePortfolio({
    scenarios,
    objective: params.objective,
    source,
    ...(params.maxWeight !== undefined ? { maxWeight: params.maxWeight } : {}),
    ...(params.views !== undefined ? { views: params.views } : {}),
  });
}
