/**
 * The `MonteCarloNode` surface (PRD 5.8).
 *
 * > Execution: 100k paths x 252 steps x 40 assets runs on Ray across the
 * > cluster; result matrices persist to S3 and the node holds a reference plus
 * > summary statistics, **so the browser never loads a 4GB array.**
 *
 * > Outputs: full `distribution` port (percentiles, moments, CVaR at
 * > configurable alpha, drawdown distribution) plus a path sample for
 * > visualization.
 *
 * Two things this file is careful about, and they pull in opposite directions.
 *
 * **What crosses the boundary.** The engine already refuses to build the path
 * cube; the sentence about the 4GB array is satisfied in Rust before anything
 * reaches here. But the sorted terminal values are `paths` long, and copying
 * 100,000 doubles out of linear memory for a node that wants five percentiles
 * is 800KB of garbage per run. So `run` returns the summary, the requested
 * percentiles and the path sample, and the full vectors come back only when
 * asked for by name — `terminal` and `drawdownPaths` are functions, not fields.
 *
 * Laziness across a single-slot boundary is a trap, and it caught its own test.
 * The module holds one result; a second run overwrites it, and a `terminal()`
 * called afterwards reads the *new* run's values and returns them as the old
 * one's — same length, same shape, plausible numbers, wrong answer. So every
 * result carries the run it belongs to and the accessors refuse once the module
 * has moved on. A loud `ResultSuperseded` is the only honest version of a lazy
 * read from a slot somebody else can overwrite.
 *
 * **What the browser should run at all.** The PRD puts the 100k x 252 x 40
 * shape on a cluster, and single-core native it takes 30 seconds. A browser
 * asking for that shape is asking for a frozen tab, so `estimateCost` reports
 * the asset-steps before anything runs and `run` refuses past a ceiling the
 * caller sets. The node's job is the optimistic local preview of PRD 7.1 — a
 * smaller path count, answered immediately, replaced by the server's
 * authoritative run when it lands — and a preview that hangs is worse than no
 * preview.
 */

import { readFloats, type PricingExports } from './module.js';

export interface McAsset {
  /** For the error message and the output labels. */
  id: string;
  spot: number;
  /** Units held. Negative is short, and the drawdown statistics follow it. */
  weight: number;
  /** Annualized volatility. */
  vol: number;
  rate: number;
  dividend: number;
}

export type Correlation =
  | { kind: 'independent' }
  | { kind: 'equicorrelated'; rho: number }
  /** Row-major, `assets.length` squared. */
  | { kind: 'matrix'; values: readonly number[] };

export interface McSpec {
  assets: readonly McAsset[];
  correlation: Correlation;
  /** Horizon in years. */
  time: number;
  paths: number;
  steps: number;
  /** Antithetic pairing. On by default; there is no reason to turn it off. */
  antithetic?: boolean;
  seed?: number;
  /** Paths kept in full for the chart. */
  samplePaths?: number;
  /** Percentiles to read back, in [0, 1]. */
  percentiles?: readonly number[];
  /** CVaR levels to read back. */
  cvarLevels?: readonly number[];
  /**
   * Largest run this caller will accept, in asset-steps
   * (`paths * steps * assets`). Defaults to `DEFAULT_COST_CEILING`.
   */
  maxAssetSteps?: number;
}

export interface McMoments {
  mean: number;
  variance: number;
  skewness: number;
  /** Zero for a normal. */
  excessKurtosis: number;
  standardError: number;
}

export interface McResult {
  paths: number;
  steps: number;
  assets: number;
  moments: McMoments;
  /** Requested terminal-value percentiles, keyed by the level asked for. */
  percentiles: Record<string, number>;
  /** Requested CVaR levels, on the left tail. */
  cvar: Record<string, number>;
  /** Drawdown percentiles in portfolio currency, at the same levels. */
  drawdown: Record<string, number>;
  /** `samplePaths` rows of `steps + 1` portfolio values. */
  sample: number[][];
  /** Values the engine retained, against the cube it never built. */
  retainedValues: number;
  cubeValues: number;
  compression: number;
  /** Full sorted terminal values. Copies out of linear memory on each call. */
  terminal: () => Float64Array;
  /** Full sorted per-path maximum drawdowns, in portfolio currency. */
  drawdownPaths: () => Float64Array;
}

/**
 * Asset-steps a browser will attempt without being told otherwise.
 *
 * Native, the engine runs about 3.3e7 asset-steps per second on one core; in
 * WASM, call it half that. 5e7 is a few seconds, which is already past what an
 * interactive node should do on the main thread and is set as a ceiling to
 * refuse at rather than a target to aim for.
 */
export const DEFAULT_COST_CEILING = 50_000_000;

export class SimulationTooLarge extends Error {
  constructor(
    readonly assetSteps: number,
    readonly ceiling: number,
  ) {
    super(
      `this run is ${assetSteps.toLocaleString('en-US')} asset-steps, past the ${ceiling.toLocaleString('en-US')} ceiling. ` +
        'Reduce the paths for a local preview, or send it to the cluster.',
    );
    this.name = 'SimulationTooLarge';
  }
}

export class CorrelationRejected extends Error {
  constructor(readonly detail: string) {
    super(`the correlation matrix was refused: ${detail}`);
    this.name = 'CorrelationRejected';
  }
}

export class ResultSuperseded extends Error {
  constructor(
    readonly run: number,
    readonly current: number,
  ) {
    super(
      `this result is from run ${run} and the module now holds run ${current}. ` +
        'Read the full vectors before starting another simulation, or keep the copy you took.',
    );
    this.name = 'ResultSuperseded';
  }
}

export class EmptySimulation extends Error {
  constructor(what: string) {
    super(`a simulation needs ${what}`);
    this.name = 'EmptySimulation';
  }
}

/** `paths * steps * assets`, the only thing the cost actually scales with. */
export function estimateCost(spec: Pick<McSpec, 'assets' | 'paths' | 'steps'>): number {
  return spec.assets.length * Math.max(0, spec.paths) * Math.max(0, spec.steps);
}

function correlationMatrix(spec: McSpec): readonly number[] | 'equicorrelated' {
  const n = spec.assets.length;
  switch (spec.correlation.kind) {
    case 'independent': {
      const values = new Array<number>(n * n).fill(0);
      for (let i = 0; i < n; i += 1) values[i * n + i] = 1;
      return values;
    }
    case 'equicorrelated':
      return 'equicorrelated';
    case 'matrix': {
      if (spec.correlation.values.length !== n * n) {
        throw new CorrelationRejected(
          `it is ${spec.correlation.values.length} values for ${n} assets, which needs ${n * n}`,
        );
      }
      return spec.correlation.values;
    }
  }
}

const KEY = (level: number): string => String(level);

/**
 * Which run the module's single result slot currently holds.
 *
 * Module-scoped rather than per-`PricingExports`, which is conservative in the
 * right direction: two modules would each get their own slot and this counter
 * would refuse a read that was actually safe, where a per-module counter that
 * missed a case would allow one that was not.
 */
let currentRun = 0;

export function runMonteCarlo(exports: PricingExports, spec: McSpec): McResult {
  if (spec.assets.length === 0) throw new EmptySimulation('at least one asset');
  if (spec.paths <= 0 || spec.steps <= 0) throw new EmptySimulation('paths and steps');

  const ceiling = spec.maxAssetSteps ?? DEFAULT_COST_CEILING;
  const cost = estimateCost(spec);
  if (cost > ceiling) throw new SimulationTooLarge(cost, ceiling);

  currentRun += 1;
  const run = currentRun;

  exports.pc_mc_reset();
  for (const asset of spec.assets) {
    exports.pc_mc_add_asset(asset.spot, asset.weight, asset.vol, asset.rate, asset.dividend);
  }

  const matrix = correlationMatrix(spec);
  if (matrix === 'equicorrelated') {
    exports.pc_mc_corr_equicorrelated(
      spec.correlation.kind === 'equicorrelated' ? spec.correlation.rho : 0,
    );
  } else {
    for (const value of matrix) exports.pc_mc_corr_push(value);
  }

  const samplePaths = Math.min(spec.samplePaths ?? 32, spec.paths);
  const code = exports.pc_mc_run(
    spec.time,
    spec.paths,
    spec.steps,
    spec.antithetic === false ? 0 : 1,
    spec.seed ?? 0x5eed,
    samplePaths,
  );

  if (code < 0) {
    // The engine's codes, translated rather than passed through. A caller
    // should not have to know that -3 means a Cholesky failure, and the
    // not-positive-definite case in particular is one an analyst causes by
    // assembling correlations pairwise until they describe no joint
    // distribution at all — so it says that rather than "error -3".
    if (code === -1) throw new EmptySimulation('at least one asset');
    if (code === -2) {
      throw new CorrelationRejected('the matrix is not square in the number of assets');
    }
    if (code === -4) throw new EmptySimulation('paths and steps');
    throw new CorrelationRejected(
      'it is not a valid correlation matrix — the diagonal must be one, it must be symmetric, ' +
        'and it must be positive definite. Correlations assembled pair by pair routinely are not.',
    );
  }

  const summary = readFloats(exports.memory, exports.pc_mc_summary(), 9);
  const paths = summary[5] as number;
  const steps = summary[6] as number;
  const retainedValues = summary[7] as number;
  const cubeValues = summary[8] as number;

  const levels = spec.percentiles ?? [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99];
  const percentiles: Record<string, number> = {};
  const drawdown: Record<string, number> = {};
  for (const level of levels) {
    percentiles[KEY(level)] = exports.pc_mc_percentile(level);
    drawdown[KEY(level)] = exports.pc_mc_drawdown_percentile(level);
  }

  const cvar: Record<string, number> = {};
  for (const level of spec.cvarLevels ?? [0.01, 0.05, 0.1]) {
    cvar[KEY(level)] = exports.pc_mc_cvar(level);
  }

  const rows = exports.pc_mc_sample_rows();
  const width = steps + 1;
  const flat = rows > 0 ? readFloats(exports.memory, exports.pc_mc_sample(), rows * width) : new Float64Array(0);
  const sample: number[][] = [];
  for (let row = 0; row < rows; row += 1) {
    sample.push(Array.from(flat.subarray(row * width, (row + 1) * width)));
  }

  return {
    paths,
    steps,
    assets: spec.assets.length,
    moments: {
      mean: summary[0] as number,
      variance: summary[1] as number,
      skewness: summary[2] as number,
      excessKurtosis: summary[3] as number,
      standardError: summary[4] as number,
    },
    percentiles,
    cvar,
    drawdown,
    sample,
    retainedValues,
    cubeValues,
    compression: retainedValues === 0 ? Infinity : cubeValues / retainedValues,
    // Deliberately lazy. 100,000 doubles is 800KB, and a node that wants five
    // percentiles should not pay for it to find that out — but the module holds
    // one result, so a read after the next run is refused rather than answered
    // with the wrong run's numbers.
    terminal: () => {
      if (run !== currentRun) throw new ResultSuperseded(run, currentRun);
      return readFloats(exports.memory, exports.pc_mc_terminal(), paths);
    },
    drawdownPaths: () => {
      if (run !== currentRun) throw new ResultSuperseded(run, currentRun);
      return readFloats(exports.memory, exports.pc_mc_drawdown(), paths);
    },
  };
}
