/**
 * `ScenarioNode` (PRD 5.8).
 *
 * "A named set of shocks with a probability weight. Shocks are typed and
 * compose: rate curve deltas, equity index moves, vol surface shifts, credit
 * spread widening, FX moves, commodity moves, and arbitrary user-defined
 * factor shocks. Scenarios can be built from history (replay the actual factor
 * moves of 2013 taper, March 2020, Oct 2023) or constructed. The scenario grid
 * renders as a `surface` where each cell is a full portfolio revaluation."
 *
 * The word carrying the most weight is **compose**, and getting it right is
 * the whole reason this is a module rather than a record with a list in it.
 * Two shocks of the same kind on the same target must combine into one, and
 * *how* they combine depends on what the number is:
 *
 * - **Returns compose multiplicatively.** An index down 5 percent and then
 *   down another 3 percent is down 7.85 percent, not 8. Adding them is wrong
 *   in the direction that flatters the book — it overstates the loss on
 *   down-moves and understates the gain on up-moves — and the error grows with
 *   the size of the shock, which is to say it is largest exactly in the
 *   scenarios anybody builds a scenario node for.
 * - **Levels compose additively.** A curve shocked +50bp and then +25bp is at
 *   +75bp, because a basis-point delta is a change in a rate level and not a
 *   return on one. Same for vol points, credit spreads and factor sigmas.
 *
 * So the composition rule is per-shock-kind and not a single `merge`. A module
 * that composed everything one way would be silently wrong for half the shock
 * types in the PRD's own list.
 */

import type { Scenario, Shock } from '@picasso/canvas-core';

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** What identifies "the same target" for a shock kind. */
export function shockTarget(shock: Shock): string {
  switch (shock.kind) {
    case 'curve':
      return `curve:${shock.currency}`;
    case 'equity_index':
      return `equity_index:${shock.index}`;
    case 'vol_surface':
      return `vol_surface:${shock.underlying}`;
    case 'credit':
      return `credit:${shock.bucket}`;
    case 'fx':
      return `fx:${shock.pair}`;
    case 'factor':
      return `factor:${shock.factor}`;
  }
}

/** Percentage moves are returns; everything else here is a level. */
export function composesMultiplicatively(kind: Shock['kind']): boolean {
  return kind === 'equity_index' || kind === 'fx';
}

function composePair(a: Shock, b: Shock): Shock {
  switch (a.kind) {
    case 'curve': {
      const other = b as Extract<Shock, { kind: 'curve' }>;
      const tenorDeltasBps: Record<string, number> = { ...a.tenorDeltasBps };
      for (const [tenor, bps] of Object.entries(other.tenorDeltasBps)) {
        tenorDeltasBps[tenor] = (tenorDeltasBps[tenor] ?? 0) + bps;
      }
      return { kind: 'curve', currency: a.currency, tenorDeltasBps };
    }
    case 'equity_index': {
      const other = b as Extract<Shock, { kind: 'equity_index' }>;
      // (1 + a)(1 + b) - 1, not a + b.
      return {
        kind: 'equity_index',
        index: a.index,
        pct: (1 + a.pct) * (1 + other.pct) - 1,
      };
    }
    case 'fx': {
      const other = b as Extract<Shock, { kind: 'fx' }>;
      return { kind: 'fx', pair: a.pair, pct: (1 + a.pct) * (1 + other.pct) - 1 };
    }
    case 'vol_surface': {
      const other = b as Extract<Shock, { kind: 'vol_surface' }>;
      const parallel = (a.parallelVolPts ?? 0) + (other.parallelVolPts ?? 0);
      const skew = (a.skewDelta ?? 0) + (other.skewDelta ?? 0);
      const composed: Extract<Shock, { kind: 'vol_surface' }> = {
        kind: 'vol_surface',
        underlying: a.underlying,
      };
      // Absent and zero are different: a scenario that does not touch skew
      // should not start carrying a skew field of 0, which reads as "we shocked
      // skew and it came out flat".
      if (a.parallelVolPts !== undefined || other.parallelVolPts !== undefined) {
        composed.parallelVolPts = parallel;
      }
      if (a.skewDelta !== undefined || other.skewDelta !== undefined) {
        composed.skewDelta = skew;
      }
      return composed;
    }
    case 'credit': {
      const other = b as Extract<Shock, { kind: 'credit' }>;
      return { kind: 'credit', bucket: a.bucket, spreadBps: a.spreadBps + other.spreadBps };
    }
    case 'factor': {
      const other = b as Extract<Shock, { kind: 'factor' }>;
      return { kind: 'factor', factor: a.factor, sigma: a.sigma + other.sigma };
    }
  }
}

/**
 * Collapse a shock list so each target appears once.
 *
 * Order is preserved by first appearance, so a composed scenario reads in the
 * order the analyst built it rather than in whatever order a map iterated.
 */
export function compose(shocks: readonly Shock[]): Shock[] {
  const byTarget = new Map<string, Shock>();
  for (const shock of shocks) {
    const key = shockTarget(shock);
    const existing = byTarget.get(key);
    byTarget.set(key, existing === undefined ? shock : composePair(existing, shock));
  }
  return [...byTarget.values()];
}

/** Compose two scenarios into one. Used by every grid cell. */
export function combine(a: Scenario, b: Scenario, id: string, name?: string): Scenario {
  return {
    id,
    name: name ?? `${a.name} + ${b.name}`,
    shocks: compose([...a.shocks, ...b.shocks]),
    // Independence is not assumed. A joint probability is the analyst's to
    // state, and multiplying two marginals here would invent a correlation of
    // zero between exactly the events a scenario grid exists to cross.
    source: a.source === b.source ? a.source : 'constructed',
  };
}

// ---------------------------------------------------------------------------
// Historical replay
// ---------------------------------------------------------------------------

export interface FactorMove {
  date: string;
  /** Target key, as `shockTarget` produces. */
  target: string;
  shock: Shock;
}

export class EmptyReplayWindow extends Error {
  constructor(from: string, to: string) {
    super(`no factor moves between ${from} and ${to}; a replay of nothing is not a scenario`);
    this.name = 'EmptyReplayWindow';
  }
}

/**
 * "replay the actual factor moves of 2013 taper, March 2020, Oct 2023"
 *
 * Every move inside the window, composed. The composition rule is what makes
 * this correct over a multi-day window: March 2020 is not one down-move, it is
 * twenty, and summing twenty daily percentage moves overstates the drawdown by
 * several points.
 *
 * An empty window throws rather than returning a scenario with no shocks in
 * it. A scenario named "March 2020" that does nothing is worse than an error,
 * because it will be wired into a grid and quietly report no loss.
 */
export function replay(
  moves: readonly FactorMove[],
  from: string,
  to: string,
  id: string,
  name: string,
): Scenario {
  const inWindow = moves.filter((m) => m.date >= from && m.date <= to);
  if (inWindow.length === 0) throw new EmptyReplayWindow(from, to);
  return {
    id,
    name,
    shocks: compose(inWindow.map((m) => m.shock)),
    source: 'historical_replay',
  };
}

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

export interface GridAxis {
  name: string;
  /** Each point is a scenario applied along this axis. */
  points: Scenario[];
}

export interface ScenarioCell {
  row: number;
  column: number;
  scenario: Scenario;
  /** Full portfolio revaluation under the composed shocks. */
  value: number;
  /** Change from the unshocked book. */
  pnl: number;
}

export interface ScenarioGrid {
  rows: GridAxis;
  columns: GridAxis;
  base: number;
  cells: ScenarioCell[];
  /** Revaluations performed. `rows × columns`, stated so the cost is visible. */
  revaluations: number;
  worst: ScenarioCell;
  best: ScenarioCell;
}

export type Revalue = (shocks: readonly Shock[]) => number;

/**
 * Every cell is a full revaluation, which is the expensive and correct choice.
 *
 * The cheap alternative is a Taylor expansion off the base Greeks, and it is
 * wrong exactly where a scenario grid is used: a second-order approximation of
 * an option book under a 50bp rate move and a 10 vol point shift misses the
 * cross-gamma entirely, and the analyst who built the grid built it to see
 * what happens in the corner.
 */
export function evaluateGrid(rows: GridAxis, columns: GridAxis, revalue: Revalue): ScenarioGrid {
  const base = revalue([]);
  const cells: ScenarioCell[] = [];

  for (let r = 0; r < rows.points.length; r += 1) {
    for (let c = 0; c < columns.points.length; c += 1) {
      const rowScenario = rows.points[r]!;
      const columnScenario = columns.points[c]!;
      const scenario = combine(rowScenario, columnScenario, `${rowScenario.id}×${columnScenario.id}`);
      const value = revalue(scenario.shocks);
      cells.push({ row: r, column: c, scenario, value, pnl: value - base });
    }
  }

  let worst = cells[0];
  let best = cells[0];
  for (const cell of cells) {
    if (!worst || cell.pnl < worst.pnl) worst = cell;
    if (!best || cell.pnl > best.pnl) best = cell;
  }
  if (!worst || !best) throw new Error('a scenario grid needs at least one cell on each axis');

  return {
    rows,
    columns,
    base,
    cells,
    revaluations: cells.length,
    worst,
    best,
  };
}

/** The `surface` port's payload: pnl by [row][column]. */
export function toSurface(grid: ScenarioGrid): number[][] {
  const out: number[][] = Array.from({ length: grid.rows.points.length }, () =>
    new Array<number>(grid.columns.points.length).fill(Number.NaN),
  );
  for (const cell of grid.cells) out[cell.row]![cell.column] = cell.pnl;
  return out;
}

// ---------------------------------------------------------------------------
// Tail attribution
// ---------------------------------------------------------------------------

export interface TailContribution {
  positionId: string;
  pnl: number;
  /** Share of the total loss in the worst cell. */
  share: number;
}

/**
 * "identify the three positions contributing the most tail risk" (PRD 5.7).
 *
 * Shares are taken over the summed *losses*, not over the net. A book whose
 * worst cell nets to -100 out of a -400 loss against a +300 gain would
 * otherwise report a position losing 200 as "200 percent of the loss", which
 * is a number that tells the analyst nothing except that the denominator was
 * chosen carelessly.
 */
export function tailContributors(
  byPosition: ReadonlyMap<string, number>,
  limit = 3,
): TailContribution[] {
  const losses = [...byPosition.entries()].filter(([, pnl]) => pnl < 0);
  const totalLoss = losses.reduce((total, [, pnl]) => total + pnl, 0);
  return losses
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit)
    .map(([positionId, pnl]) => ({
      positionId,
      pnl,
      share: totalLoss === 0 ? 0 : pnl / totalLoss,
    }));
}
