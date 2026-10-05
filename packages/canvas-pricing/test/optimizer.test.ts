import { describe, expect, it } from 'vitest';
import {
  OptimizationRefused,
  optimizePortfolio,
  projectCappedSimplex,
  type ScenarioMatrix,
} from '../src/optimizer.js';

function gaussian(seed: number): () => number {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

/** Scenarios with given mean returns and vols, correlated through one factor. */
function scenarios(mu: number[], vol: number[], loading: number[], S: number, seed: number, fat = false): ScenarioMatrix {
  const z = gaussian(seed);
  const K = mu.length;
  const levels = new Float64Array(S * K);
  for (let s = 0; s < S; s += 1) {
    // A fat-tailed common shock when asked: a crash day on one in twenty.
    const common = fat && s % 20 === 0 ? -4 + z() : z();
    for (let k = 0; k < K; k += 1) {
      const e = loading[k]! * common + Math.sqrt(1 - loading[k]! ** 2) * z();
      levels[s * K + k] = 100 * (1 + mu[k]! + vol[k]! * e);
    }
  }
  return { assets: mu.map((_, k) => `A${k}`), spots: mu.map(() => 100), levels };
}

/** Rockafellar-Uryasev CVaR of a portfolio, written here rather than imported. */
function cvarOf(m: ScenarioMatrix, w: number[], alpha: number): number {
  const K = w.length;
  const S = m.levels.length / K;
  const losses: number[] = [];
  for (let s = 0; s < S; s += 1) {
    let r = 0;
    for (let k = 0; k < K; k += 1) r += w[k]! * (m.levels[s * K + k]! / m.spots[k]! - 1);
    losses.push(-r);
  }
  losses.sort((a, b) => a - b);
  const zeta = losses[Math.ceil(alpha * S) - 1]!;
  return zeta + losses.reduce((a, l) => a + Math.max(0, l - zeta), 0) / ((1 - alpha) * S);
}

describe('projectCappedSimplex', () => {
  it('lands on the set, and nearer than any other point of it', () => {
    const z = gaussian(5);
    for (let trial = 0; trial < 50; trial += 1) {
      const v = [z(), z(), z(), z()];
      const p = projectCappedSimplex(v, 0.4);
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
      expect(p.every((x) => x >= -1e-15 && x <= 0.4 + 1e-15)).toBe(true);
      const d = (q: number[]) => q.reduce((a, x, i) => a + (x - v[i]!) ** 2, 0);
      for (let k = 0; k < 20; k += 1) {
        const q = projectCappedSimplex([z(), z(), z(), z()], 0.4);
        expect(d(p)).toBeLessThanOrEqual(d(q) + 1e-12);
      }
    }
  });
});

describe('mean-variance', () => {
  const m = scenarios([0.04, 0.06, 0.05], [0.15, 0.25, 0.2], [0.5, 0.6, 0.3], 20_000, 1);

  it('matches the closed form when no bound binds', () => {
    // With only the budget binding, w = Sigma^-1 (mu - nu 1) / lambda, nu set
    // so the weights sum to one. Solved here by Gaussian elimination on the
    // scenarios' own covariance — no projected gradient involved.
    const lambda = 4;
    const r = optimizePortfolio({ scenarios: m, objective: { kind: 'mean_variance', riskAversion: lambda }, source: 'synthetic' });
    const K = 3;
    const S = m.levels.length / K;
    const ret = (s: number, k: number) => m.levels[s * K + k]! / 100 - 1;
    const mean = [0, 1, 2].map((k) => Array.from({ length: S }, (_, s) => ret(s, k)).reduce((a, b) => a + b, 0) / S);
    const cov = [0, 1, 2].map((i) => [0, 1, 2].map((j) => {
      let c = 0;
      for (let s = 0; s < S; s += 1) c += (ret(s, i) - mean[i]!) * (ret(s, j) - mean[j]!);
      return c / (S - 1);
    }));
    const solve = (a: number[][], b: number[]) => {
      const x = a.map((row, i) => [...row, b[i]!]);
      for (let c = 0; c < 3; c += 1) for (let r2 = c + 1; r2 < 3; r2 += 1) {
        const f = x[r2]![c]! / x[c]![c]!;
        for (let j = c; j <= 3; j += 1) x[r2]![j]! -= f * x[c]![j]!;
      }
      const out = [0, 0, 0];
      for (let c = 2; c >= 0; c -= 1) out[c] = (x[c]![3]! - [0, 1, 2].filter((j) => j > c).reduce((s, j) => s + x[c]![j]! * out[j]!, 0)) / x[c]![c]!;
      return out;
    };
    const a = solve(cov, mean);
    const b = solve(cov, [1, 1, 1]);
    const nu = (a.reduce((x, y) => x + y, 0) - lambda) / b.reduce((x, y) => x + y, 0);
    const closed = a.map((v, i) => (v - nu * b[i]!) / lambda);
    expect(closed.every((x) => x > 0)).toBe(true);
    r.weights.forEach((w, i) => expect(w.weight).toBeCloseTo(closed[i]!, 8));
    expect(r.diagnostics.kktResidual!).toBeLessThan(1e-10);
  });

  it('satisfies the KKT conditions when bounds bind', () => {
    const r = optimizePortfolio({
      scenarios: m,
      objective: { kind: 'mean_variance', riskAversion: 1 },
      maxWeight: 0.5,
      views: { A0: 0.02, A1: 0.12, A2: 0.03 },
      source: 'synthetic',
    });
    expect(r.weights.map((w) => w.bound)).toContain('capped');
    expect(r.diagnostics.kktResidual!).toBeLessThan(1e-9);
    expect(r.weights.reduce((s, w) => s + w.weight, 0)).toBeCloseTo(1, 12);
  });
});

describe('minimum CVaR', () => {
  it('finds the brute-force minimum over a fine grid of two assets', () => {
    const m = scenarios([0.03, 0.05], [0.12, 0.3], [0.4, 0.7], 4_000, 2, true);
    const r = optimizePortfolio({ scenarios: m, objective: { kind: 'min_cvar', alpha: 0.95 }, source: 'synthetic' });
    let best = Infinity;
    let bestW = 0;
    for (let i = 0; i <= 1_000; i += 1) {
      const c = cvarOf(m, [i / 1_000, 1 - i / 1_000], 0.95);
      if (c < best) {
        best = c;
        bestW = i / 1_000;
      }
    }
    const mine = cvarOf(m, r.weights.map((w) => w.weight), 0.95);
    expect(mine).toBeLessThanOrEqual(best + 1e-12);
    expect(Math.abs(r.weights[0]!.weight - bestW)).toBeLessThan(2e-3);
    expect(r.conditionalValueAtRisk).toBeCloseTo(mine, 12);
  });

  it('beats every point of a three-asset grid', () => {
    const m = scenarios([0.03, 0.05, 0.04], [0.12, 0.3, 0.2], [0.4, 0.7, 0.5], 3_000, 3, true);
    const r = optimizePortfolio({ scenarios: m, objective: { kind: 'min_cvar', alpha: 0.9 }, maxWeight: 0.7, source: 'synthetic' });
    const mine = cvarOf(m, r.weights.map((w) => w.weight), 0.9);
    for (let i = 0; i <= 50; i += 1)
      for (let j = 0; i + j <= 50; j += 1) {
        const w = [i / 50, j / 50, 1 - (i + j) / 50];
        if (w.some((x) => x > 0.7 + 1e-12)) continue;
        expect(mine).toBeLessThanOrEqual(cvarOf(m, w, 0.9) + 1e-12);
      }
  });

  it('meets a target return, and refuses one no portfolio can meet', () => {
    const m = scenarios([0.03, 0.05], [0.12, 0.3], [0.4, 0.7], 4_000, 2);
    const views = { A0: 0.03, A1: 0.08 };
    const r = optimizePortfolio({ scenarios: m, objective: { kind: 'min_cvar', alpha: 0.95, targetReturn: 0.07 }, views, source: 'synthetic' });
    expect(r.expectedReturn).toBeGreaterThanOrEqual(0.07 - 1e-9);
    expect(() =>
      optimizePortfolio({ scenarios: m, objective: { kind: 'min_cvar', alpha: 0.95, targetReturn: 0.09 }, views, source: 'synthetic' }),
    ).toThrow(/meets the target return/);
  });
});

describe('what the result says about itself', () => {
  it('warns that risk-neutral scenarios carry no return signal', () => {
    // Every asset with the same expected return: what a risk-neutral
    // simulation hands over.
    const m = scenarios([0.02, 0.02, 0.02], [0.15, 0.25, 0.2], [0.5, 0.6, 0.3], 5_000, 4);
    const r = optimizePortfolio({ scenarios: m, objective: { kind: 'mean_variance', riskAversion: 3 }, source: 'risk-neutral GBM' });
    expect(r.warnings.join(' ')).toMatch(/mean-variance here is minimum variance/);
    expect(r.assumptions[0]).toBe('scenarios: 5000 joint outcomes from risk-neutral GBM');
    // With views the warning goes, and the assumption names them.
    const v = optimizePortfolio({
      scenarios: m,
      objective: { kind: 'mean_variance', riskAversion: 3 },
      views: { A1: 0.1 },
      source: 'risk-neutral GBM',
    });
    expect(v.warnings.join(' ')).not.toMatch(/no return signal/);
    expect(v.assumptions[1]).toMatch(/the analyst's views for A1/);
  });

  it('warns when the tail rests on few scenarios', () => {
    const m = scenarios([0.03, 0.05], [0.12, 0.3], [0.4, 0.7], 1_000, 2);
    const r = optimizePortfolio({ scenarios: m, objective: { kind: 'min_cvar', alpha: 0.95 }, source: 'synthetic' });
    expect(r.warnings.join(' ')).toMatch(/holds 50 of 1000 scenarios/);
  });

  it('refuses inputs it cannot honour', () => {
    const m = scenarios([0.03, 0.05], [0.12, 0.3], [0.4, 0.7], 500, 2);
    const mv = { kind: 'mean_variance' as const, riskAversion: 2 };
    expect(() => optimizePortfolio({ scenarios: m, objective: mv, source: ' ' })).toThrow(/no source/);
    expect(() => optimizePortfolio({ scenarios: m, objective: mv, maxWeight: 0.4, source: 's' })).toThrow(/cannot add up/);
    expect(() => optimizePortfolio({ scenarios: m, objective: mv, views: { NVDA: 0.1 }, source: 's' })).toThrow(/not among the assets/);
    expect(() => optimizePortfolio({ scenarios: m, objective: { kind: 'mean_variance', riskAversion: 0 }, source: 's' })).toThrow(
      OptimizationRefused,
    );
  });
});
