/**
 * A small linear-program solver, for the optimizer's minimum-CVaR master
 * problem.
 *
 * Two-phase dense simplex with Bland's rule. Dense because the problems it
 * sees are small — the cutting-plane master has one column per asset plus
 * three, and one row per cut — and Bland's rule because it cannot cycle,
 * which matters more here than speed: a degenerate vertex is the normal case
 * when several assets sit at a weight bound together.
 *
 * Every variable is non-negative; a free variable is the caller's to split.
 */

export interface Constraint {
  coefficients: readonly number[];
  op: '<=' | '=' | '>=';
  rhs: number;
}

export interface LinearProgram {
  /** Minimised. */
  objective: readonly number[];
  constraints: readonly Constraint[];
}

export type LpResult =
  | { status: 'optimal'; x: number[]; value: number; pivots: number }
  | { status: 'infeasible' }
  | { status: 'unbounded' };

const EPS = 1e-10;
const MAX_PIVOTS = 50_000;

export class LpDidNotTerminate extends Error {
  constructor() {
    super(`the simplex did not terminate within ${MAX_PIVOTS} pivots`);
    this.name = 'LpDidNotTerminate';
  }
}

export function solveLp(lp: LinearProgram): LpResult {
  const n = lp.objective.length;
  const rows = lp.constraints.map((c) => {
    if (c.coefficients.length !== n) throw new RangeError(`a constraint has ${c.coefficients.length} coefficients for ${n} variables`);
    // Non-negative right-hand sides, so the starting basis is feasible.
    return c.rhs < 0
      ? { a: c.coefficients.map((v) => -v), op: c.op === '<=' ? '>=' : c.op === '>=' ? '<=' : '=', b: -c.rhs }
      : { a: [...c.coefficients], op: c.op, b: c.rhs };
  });
  const m = rows.length;

  // Columns: originals, then one slack or surplus per inequality, then one
  // artificial per >= or = row.
  const slackCount = rows.filter((r) => r.op !== '=').length;
  const artificialCount = rows.filter((r) => r.op !== '<=').length;
  const width = n + slackCount + artificialCount;
  const tableau: number[][] = [];
  const basis: number[] = [];
  const artificial = new Set<number>();
  let slack = n;
  let art = n + slackCount;
  for (const row of rows) {
    const line = new Array<number>(width + 1).fill(0);
    for (let j = 0; j < n; j += 1) line[j] = row.a[j]!;
    line[width] = row.b;
    if (row.op === '<=') {
      line[slack] = 1;
      basis.push(slack);
      slack += 1;
    } else {
      if (row.op === '>=') {
        line[slack] = -1;
        slack += 1;
      }
      line[art] = 1;
      basis.push(art);
      artificial.add(art);
      art += 1;
    }
    tableau.push(line);
  }

  let pivots = 0;
  const pivot = (r: number, c: number): void => {
    pivots += 1;
    if (pivots > MAX_PIVOTS) throw new LpDidNotTerminate();
    const row = tableau[r]!;
    const p = row[c]!;
    for (let j = 0; j <= width; j += 1) row[j]! /= p;
    for (let i = 0; i < m; i += 1) {
      if (i === r) continue;
      const other = tableau[i]!;
      const f = other[c]!;
      if (f === 0) continue;
      for (let j = 0; j <= width; j += 1) other[j]! -= f * row[j]!;
    }
    basis[r] = c;
  };

  /** Runs the simplex on cost vector `cost` over `allowed` columns. */
  const run = (cost: readonly number[], allowed: (j: number) => boolean): 'optimal' | 'unbounded' => {
    for (;;) {
      // Reduced costs from the current basis.
      let entering = -1;
      for (let j = 0; j < width && entering < 0; j += 1) {
        if (!allowed(j) || basis.includes(j)) continue;
        let reduced = cost[j] ?? 0;
        for (let i = 0; i < m; i += 1) reduced -= (cost[basis[i]!] ?? 0) * tableau[i]![j]!;
        if (reduced < -EPS) entering = j; // Bland: lowest index first
      }
      if (entering < 0) return 'optimal';
      let leaving = -1;
      let best = Infinity;
      for (let i = 0; i < m; i += 1) {
        const a = tableau[i]![entering]!;
        if (a <= EPS) continue;
        const ratio = tableau[i]![width]! / a;
        if (ratio < best - EPS || (Math.abs(ratio - best) <= EPS && basis[i]! < basis[leaving]!)) {
          best = ratio;
          leaving = i;
        }
      }
      if (leaving < 0) return 'unbounded';
      pivot(leaving, entering);
    }
  };

  // Phase I: drive the artificials to zero.
  if (artificialCount > 0) {
    const phase1 = new Array<number>(width).fill(0);
    for (const j of artificial) phase1[j] = 1;
    run(phase1, () => true);
    let infeasibility = 0;
    for (let i = 0; i < m; i += 1) if (artificial.has(basis[i]!)) infeasibility += tableau[i]![width]!;
    if (infeasibility > 1e-8) return { status: 'infeasible' };
    // An artificial still basic at zero is pivoted out where possible; a row
    // with nothing else to pivot on is redundant and harmless at zero.
    for (let i = 0; i < m; i += 1) {
      if (!artificial.has(basis[i]!)) continue;
      for (let j = 0; j < n + slackCount; j += 1) {
        if (Math.abs(tableau[i]![j]!) > EPS) {
          pivot(i, j);
          break;
        }
      }
    }
  }

  // Phase II on the original objective, artificials excluded.
  const cost = [...lp.objective, ...new Array<number>(width - n).fill(0)];
  if (run(cost, (j) => !artificial.has(j)) === 'unbounded') return { status: 'unbounded' };

  const x = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i += 1) if (basis[i]! < n) x[basis[i]!] = tableau[i]![width]!;
  const value = lp.objective.reduce((s, c, j) => s + c * x[j]!, 0);
  return { status: 'optimal', x, value, pivots };
}
