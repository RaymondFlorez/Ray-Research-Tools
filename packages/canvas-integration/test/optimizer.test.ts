/**
 * The optimizer seam: pricing-core's Monte Carlo → canvas-pricing's
 * OptimizerNode (PRD 3.3, 5.8).
 *
 * The simulator and the optimizer are each tested alone. What neither can
 * check is that the scenarios mean the same thing on both sides — rows are
 * paths, columns are assets in the order they were added, levels convert to
 * returns against the spots the run started from — and that the joint law
 * the simulator was asked for is the one the optimizer allocates against.
 */

import { describe, expect, it } from 'vitest';
import {
  createOptimizerNode,
  evaluateOptimizerNode,
  runMonteCarlo,
  type GbmAsset,
  type McSpec,
} from '@picasso/canvas-pricing';
import { loadPricing } from './load.js';

// Three semis names correlated at 0.7, and a low-vol diversifier.
function spec(dependence?: McSpec['dependence']): McSpec {
  const names: Array<[string, number]> = [['NVDA', 0.55], ['AMD', 0.5], ['AVGO', 0.4], ['UTIL', 0.15]];
  const assets: GbmAsset[] = names.map(([id, vol]) => ({ id, spot: 100, weight: 1, vol, rate: 0.04, dividend: 0 }));
  const rho = 0.7;
  const values = assets.flatMap((_, i) => assets.map((__, j) => (i === j ? 1 : i < 3 && j < 3 ? rho : 0.2)));
  return {
    assets,
    correlation: { kind: 'matrix', values },
    time: 0.5,
    paths: 20_000,
    steps: 32,
    seed: 0x0b7,
    keepScenarios: true,
    ...(dependence ? { dependence } : {}),
  };
}

describe('Monte Carlo scenarios → OptimizerNode', () => {
  const node = createOptimizerNode({ id: 'opt', objective: { kind: 'min_cvar', alpha: 0.95 }, maxWeight: 0.6 });

  it("reads the scenarios the run produced, in the run's asset order", async () => {
    const exports = await loadPricing();
    const run = runMonteCarlo(exports, spec());
    const scenarios = run.scenarios!;
    expect(scenarios.assets).toEqual(['NVDA', 'AMD', 'AVGO', 'UTIL']);
    const levels = scenarios.levels();
    expect(levels.length).toBe(20_000 * 4);
    // Equal-weighted rows reproduce the run's own portfolio distribution.
    const rebuilt = Array.from({ length: 20_000 }, (_, s) => levels[4 * s]! + levels[4 * s + 1]! + levels[4 * s + 2]! + levels[4 * s + 3]!);
    expect(rebuilt.reduce((a, b) => a + b, 0) / 20_000).toBeCloseTo(run.moments.mean, 9);
  });

  it('allocates against the joint law it was handed', async () => {
    const exports = await loadPricing();
    const result = (dependence?: McSpec['dependence']) => {
      const run = runMonteCarlo(exports, spec(dependence));
      return evaluateOptimizerNode(node, { ...run.scenarios!, levels: run.scenarios!.levels() }, dependence ? 't copula, 4 dof' : 'gaussian');
    };
    const gaussian = result();
    const t = result({ kind: 't', nu: 4 });
    // Measured. The diversifier sits at its 60% cap and NVDA is excluded
    // under both laws; the t copula's heavier joint tail moves the semis
    // weights and raises the best achievable CVaR from 23.11% to 23.79%.
    const weights = (r: typeof gaussian) => r.weights.map((w) => Number(w.weight.toFixed(4)));
    expect(weights(gaussian)).toEqual([0, 0.0348, 0.3652, 0.6]);
    expect(weights(t)).toEqual([0, 0.0484, 0.3516, 0.6]);
    expect(gaussian.conditionalValueAtRisk).toBeCloseTo(0.2311, 4);
    expect(t.conditionalValueAtRisk).toBeCloseTo(0.2379, 4);
    expect(t.weights.map((w) => w.bound ?? null)).toEqual(['excluded', null, null, 'capped']);
    expect(t.assumptions[0]).toBe('scenarios: 20000 joint outcomes from t copula, 4 dof');
    // Risk-neutral scenarios drift every name at the rate, and the node says so.
    expect(gaussian.warnings.join(' ')).toMatch(/carry no return signal/);
  });
});
