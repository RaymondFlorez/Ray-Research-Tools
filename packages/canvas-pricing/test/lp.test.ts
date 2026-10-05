import { describe, expect, it } from 'vitest';
import { solveLp, type Constraint } from '../src/lp.js';

describe('solveLp', () => {
  it('solves the textbook maximisation', () => {
    // max 3x + 5y s.t. x <= 4, 2y <= 12, 3x + 2y <= 18: x = 2, y = 6, 36.
    const r = solveLp({
      objective: [-3, -5],
      constraints: [
        { coefficients: [1, 0], op: '<=', rhs: 4 },
        { coefficients: [0, 2], op: '<=', rhs: 12 },
        { coefficients: [3, 2], op: '<=', rhs: 18 },
      ],
    });
    expect(r.status).toBe('optimal');
    if (r.status !== 'optimal') return;
    expect(r.x[0]).toBeCloseTo(2, 10);
    expect(r.x[1]).toBeCloseTo(6, 10);
    expect(r.value).toBeCloseTo(-36, 10);
  });

  it('handles >= and = rows through phase one', () => {
    const r = solveLp({
      objective: [1, 1],
      constraints: [
        { coefficients: [1, 2], op: '>=', rhs: 4 },
        { coefficients: [3, 1], op: '>=', rhs: 6 },
      ],
    });
    expect(r.status === 'optimal' && r.value).toBeCloseTo(2.8, 10);
    const eq = solveLp({
      objective: [2, 3],
      constraints: [
        { coefficients: [1, 1], op: '=', rhs: 1 },
        { coefficients: [1, -1], op: '<=', rhs: -0.5 },
      ],
    });
    // x + y = 1 and x <= y - 0.5: x = 0.25, y = 0.75 minimises 2x + 3y.
    expect(eq.status === 'optimal' && eq.x).toEqual([expect.closeTo(0.25, 10), expect.closeTo(0.75, 10)]);
  });

  it('reports infeasible and unbounded programs as such', () => {
    expect(
      solveLp({
        objective: [1],
        constraints: [
          { coefficients: [1], op: '<=', rhs: 1 },
          { coefficients: [1], op: '>=', rhs: 2 },
        ],
      }).status,
    ).toBe('infeasible');
    expect(solveLp({ objective: [-1, 0], constraints: [{ coefficients: [1, -1], op: '<=', rhs: 1 }] }).status).toBe('unbounded');
  });

  it('terminates on Beale\'s cycling example', () => {
    // The classic program on which the largest-coefficient rule cycles
    // forever. Bland's rule must reach the optimum, -1.25.
    const r = solveLp({
      objective: [-0.75, 20, -0.5, 6],
      constraints: [
        { coefficients: [0.25, -8, -1, 9], op: '<=', rhs: 0 },
        { coefficients: [0.5, -12, -0.5, 3], op: '<=', rhs: 0 },
        { coefficients: [0, 0, 1, 0], op: '<=', rhs: 1 },
      ],
    });
    expect(r.status === 'optimal' && r.value).toBeCloseTo(-1.25, 10);
  });

  it('agrees with brute-force vertex enumeration on random programs', () => {
    // Independent check: every vertex of a 3-variable polytope is the
    // solution of three of its tight constraints, so enumerating all triples
    // and keeping the feasible ones finds the optimum without any simplex.
    let state = 12345;
    const uniform = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const solve3 = (a: number[][], b: number[]): number[] | undefined => {
      const det = (m: number[][]) =>
        m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) -
        m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) +
        m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
      const d = det(a);
      if (Math.abs(d) < 1e-12) return undefined;
      return [0, 1, 2].map((k) => det(a.map((row, i) => row.map((v, j) => (j === k ? b[i]! : v)))) / d);
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const objective = [0, 1, 2].map(() => uniform() * 2 - 1);
      const constraints: Constraint[] = [];
      for (let k = 0; k < 4; k += 1) {
        constraints.push({ coefficients: [0, 1, 2].map(() => uniform() * 2 - 0.5), op: '<=', rhs: 1 + uniform() * 3 });
      }
      // A box keeps every program bounded.
      for (let j = 0; j < 3; j += 1) constraints.push({ coefficients: [0, 1, 2].map((i) => (i === j ? 1 : 0)), op: '<=', rhs: 5 });
      const all = [
        ...constraints.map((c) => ({ a: [...c.coefficients], b: c.rhs })),
        ...[0, 1, 2].map((j) => ({ a: [0, 1, 2].map((i) => (i === j ? -1 : 0)), b: 0 })),
      ];
      let best = Infinity;
      for (let p = 0; p < all.length; p += 1)
        for (let q = p + 1; q < all.length; q += 1)
          for (let r = q + 1; r < all.length; r += 1) {
            const x = solve3([all[p]!.a, all[q]!.a, all[r]!.a], [all[p]!.b, all[q]!.b, all[r]!.b]);
            if (!x || !all.every((c) => c.a.reduce((s, v, i) => s + v * x[i]!, 0) <= c.b + 1e-9)) continue;
            best = Math.min(best, objective.reduce((s, c, i) => s + c * x[i]!, 0));
          }
      const r = solveLp({ objective, constraints });
      expect(r.status).toBe('optimal');
      if (r.status === 'optimal') expect(r.value).toBeCloseTo(best, 8);
    }
  });
});
