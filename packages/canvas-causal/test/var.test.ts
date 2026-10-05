import { describe, expect, it } from 'vitest';
import type { EdgeID, NodeID } from '@picasso/canvas-core';
import {
  fitVar,
  generalizedResponse,
  propagate,
  reducedFormResponse,
  suggestVar,
  varForCycle,
  VarNotOffered,
  type CausalLink,
} from '../src/index.js';

function normals(seed: number): () => number {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

// A three-node loop — rates -> multiples -> risk appetite -> rates — with each
// node's own persistence, and correlated innovations.
const A = [
  [0.5, 0.0, 0.25],
  [-0.4, 0.3, 0.0],
  [0.0, 0.35, 0.4],
];
const NAMES = ['rates', 'multiples', 'appetite'] as const;

function simulate(a: number[][], length: number, seed: number): Record<string, number[]> {
  const z = normals(seed);
  const k = a.length;
  const x = new Array<number>(k).fill(0);
  const out: number[][] = Array.from({ length: k }, () => []);
  for (let t = 0; t < length + 100; t += 1) {
    const common = z();
    const shock = Array.from({ length: k }, () => 0.6 * common + 0.8 * z());
    const next = a.map((row, i) => row.reduce((s, v, j) => s + v * x[j]!, 0) + shock[i]!);
    for (let i = 0; i < k; i += 1) x[i] = next[i]!;
    if (t >= 100) for (let i = 0; i < k; i += 1) out[i]!.push(x[i]!);
  }
  return Object.fromEntries(out.map((col, i) => [NAMES[i] ?? `v${i}`, col]));
}

const series = simulate(A, 2000, 1);

describe('fitVar', () => {
  const fit = fitVar(series, 1);

  it('recovers the coefficients it was generated with', () => {
    let within = 0;
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        const miss = Math.abs(fit.coefficients[0]![i]![j]! - A[i]![j]!);
        if (miss < 2 * fit.standardErrors[0]![i]![j]!) within += 1;
        expect(miss).toBeLessThan(4 * fit.standardErrors[0]![i]![j]!);
      }
    }
    // Measured: all nine inside two standard errors on this seed.
    expect(within).toBe(9);
    expect(fit.observations).toBe(1999);
    expect(fit.stable).toBe(true);
  });

  it('measures the spectral radius against the eigenvalues', () => {
    // Two variables, so the eigenvalues of the fitted matrix are a quadratic's
    // roots — complex here, with modulus sqrt(det).
    const two = simulate([[0.6, -0.5], [0.5, 0.6]], 3000, 2);
    const f = fitVar(two, 1);
    const [[a, b], [c, d]] = f.coefficients[0] as [[number, number], [number, number]];
    const trace = a + d;
    const det = a * d - b * c;
    const disc = trace * trace - 4 * det;
    const exact = disc < 0 ? Math.sqrt(det) : Math.max(Math.abs((trace + Math.sqrt(disc)) / 2), Math.abs((trace - Math.sqrt(disc)) / 2));
    // Gelfand's formula at n = 4096 is off by about cond^(1/4096); measured
    // 0.78917 against 0.78910, a relative 8.5e-5.
    expect(Math.abs(f.spectralRadius / exact - 1)).toBeLessThan(2e-4);
    expect(exact).toBeCloseTo(0.7891, 4);
  });

  it('warns when the fitted system does not settle', () => {
    const explosive = simulate([[1.02, 0.0], [0.1, 0.5]], 600, 3);
    const f = fitVar(explosive, 1);
    expect(f.stable).toBe(false);
    expect(f.warnings[0]).toMatch(/not stable/);
  });

  it('refuses what it cannot identify', () => {
    expect(() => fitVar({ a: [1, 2, 3], b: [1, 2] }, 1)).toThrow(/has 2 observations/);
    expect(() => fitVar({ a: [1, 2, 3, 4] }, 1)).toThrow(VarNotOffered);
    expect(() => fitVar(series, 0)).toThrow(/positive integer/);
  });
});

describe('impulse responses', () => {
  const fit = fitVar(series, 1);

  it('generalized response is Psi_h Sigma e_j / sigma_jj, computed independently', () => {
    const k = 3;
    const a = fit.coefficients[0]!;
    const sigma = fit.residualCovariance;
    let power: number[][] = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)));
    const girf = generalizedResponse(fit, 'multiples', 6);
    for (let h = 0; h <= 6; h += 1) {
      for (let i = 0; i < k; i += 1) {
        const expected = power[i]!.reduce((s, v, m) => s + v * sigma[m]![1]!, 0) / sigma[1]![1]!;
        expect(girf[NAMES[i]!]![h]).toBeCloseTo(expected, 12);
      }
      power = power.map((row) => Array.from({ length: k }, (_, j) => row.reduce((s, v, m) => s + v * a[m]![j]!, 0)));
    }
    // A unit shock moves its own variable by exactly one on impact.
    expect(girf.multiples![0]).toBeCloseTo(1, 12);
  });

  it('propagating the direct coefficients reproduces the VAR\'s own response', () => {
    // The reason edges carry A[to][from] and not an impulse response:
    // `propagate` composes the loop itself.
    const links: CausalLink[] = [];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        links.push({
          id: `e${i}${j}` as EdgeID,
          from: NAMES[j]! as NodeID,
          to: NAMES[i]! as NodeID,
          elasticity: fit.coefficients[0]![i]![j]!,
          lag: 1,
          method: 'var',
        });
      }
    }
    const run = propagate(links, new Map([['rates' as NodeID, 1]]), { horizon: 12, damping: 1 });
    const direct = reducedFormResponse(fit, 'rates', 12);
    for (const name of NAMES) {
      const row = run.series.get(name as NodeID)!;
      for (let h = 0; h <= 12; h += 1) expect(row[h]).toBeCloseTo(direct[name]![h]!, 12);
    }
  });
});

describe('varForCycle (Appendix C.3)', () => {
  const link = (id: string, from: string, to: string, lag = 1): CausalLink => ({
    id: id as EdgeID,
    from: from as NodeID,
    to: to as NodeID,
    elasticity: 0.1,
    lag,
    method: 'asserted',
  });
  const loop = [link('r-m', 'rates', 'multiples'), link('m-a', 'multiples', 'appetite'), link('a-r', 'appetite', 'rates')];
  const byNode = new Map(NAMES.map((n) => [n as NodeID, series[n]!]));

  it('is suggested for a drawn cycle of three, and not for a pair', () => {
    expect(suggestVar(loop).map((c) => [...c].sort())).toEqual([['appetite', 'multiples', 'rates']]);
    expect(suggestVar([link('x', 'a', 'b'), link('y', 'b', 'a')])).toEqual([]);
  });

  it('writes each drawn edge\'s direct coefficient back, and names what was not drawn', () => {
    const result = varForCycle({ links: loop, cycle: ['rates', 'multiples', 'appetite'] as NodeID[], series: byNode, window: ['2015-01-01', '2024-12-31'] });
    const byId = new Map(result.links.map((l) => [l.id, l]));
    expect(byId.get('r-m' as EdgeID)!.method).toBe('var');
    expect(byId.get('r-m' as EdgeID)!.elasticity).toBe(result.fit.coefficients[0]![1]![0]);
    expect(byId.get('m-a' as EdgeID)!.elasticity).toBe(result.fit.coefficients[0]![2]![1]);
    expect(byId.get('a-r' as EdgeID)!.elasticity).toBe(result.fit.coefficients[0]![0]![2]);
    expect(result.params.get('r-m' as EdgeID)!.estimation).toMatchObject({
      method: 'var',
      window: ['2015-01-01', '2024-12-31'],
      se: byId.get('r-m' as EdgeID)!.standardError,
    });
    // Every node's own persistence is real and undrawn, and is reported.
    const selves = result.undrawn.filter((u) => u.from === u.to).map((u) => u.from).sort();
    expect(selves).toEqual(['appetite', 'multiples', 'rates']);
  });

  it('refuses a system the analyst did not assert', () => {
    const cycle = ['rates', 'multiples'] as NodeID[];
    expect(() => varForCycle({ links: loop, cycle, series: byNode, window: ['2015-01-01', '2024-12-31'] })).toThrow(/three or more/);
    const open = [link('r-m', 'rates', 'multiples'), link('m-a', 'multiples', 'appetite')];
    expect(() => varForCycle({ links: open, cycle: ['rates', 'multiples', 'appetite'] as NodeID[], series: byNode, window: ['2015-01-01', '2024-12-31'] })).toThrow(
      /do not form a cycle/,
    );
    const contemporaneous = [link('r-m', 'rates', 'multiples', 0), loop[1]!, loop[2]!];
    expect(() => varForCycle({ links: contemporaneous, cycle: ['rates', 'multiples', 'appetite'] as NodeID[], series: byNode, window: ['2015-01-01', '2024-12-31'] })).toThrow(
      /contemporaneous/,
    );
  });
});

describe('cited edges', () => {
  it('will not build a cited edge without the citation, and the audit names it', async () => {
    const { citeEdge, MissingCitation, auditLinks, linksFromDocument, createCausalEdge } = await import('../src/index.js');
    expect(() => citeEdge(-2.1, 1, '  ')).toThrow(MissingCitation);
    const params = citeEdge(-2.1, 1, 'Bernanke and Kuttner (2005), Table 2');
    expect(params.estimation).toMatchObject({ method: 'cited', citation: 'Bernanke and Kuttner (2005), Table 2' });
    const { createDocument } = await import('@picasso/canvas-core');
    const doc = createDocument('c');
    const edge = createCausalEdge('e' as EdgeID, 'a' as NodeID, 'b' as NodeID, params);
    doc.edges.set(edge.id, edge);
    const lines = auditLinks(linksFromDocument(doc));
    expect(lines.join(' ')).toMatch(/taken from Bernanke and Kuttner \(2005\), Table 2/);
  });
});
