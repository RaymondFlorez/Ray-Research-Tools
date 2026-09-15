import { describe, expect, it } from 'vitest';
import type { Scenario, Shock } from '@picasso/canvas-core';
import {
  EmptyReplayWindow,
  combine,
  compose,
  composesMultiplicatively,
  evaluateGrid,
  replay,
  shockTarget,
  tailContributors,
  toSurface,
  type FactorMove,
  type GridAxis,
} from '../src/scenario.js';

function scenario(id: string, name: string, shocks: Shock[]): Scenario {
  return { id, name, shocks, source: 'constructed' };
}

describe('composition depends on what the number is', () => {
  // An index down 5% then down another 3% is down 7.85%, not 8. Adding
  // overstates the loss, and the error grows with the size of the shock —
  // largest exactly in the scenarios anyone builds a grid for.
  it('composes returns multiplicatively', () => {
    const composed = compose([
      { kind: 'equity_index', index: 'SPX', pct: -0.05 },
      { kind: 'equity_index', index: 'SPX', pct: -0.03 },
    ]);
    expect(composed).toHaveLength(1);
    expect((composed[0] as Extract<Shock, { kind: 'equity_index' }>).pct).toBeCloseTo(-0.0785, 10);
  });

  it('composes fx the same way, since a pair move is also a return', () => {
    const composed = compose([
      { kind: 'fx', pair: 'EURUSD', pct: 0.02 },
      { kind: 'fx', pair: 'EURUSD', pct: 0.02 },
    ]);
    expect((composed[0] as Extract<Shock, { kind: 'fx' }>).pct).toBeCloseTo(0.0404, 10);
  });

  // A basis-point delta is a change in a rate level, not a return on one.
  it('composes levels additively', () => {
    const composed = compose([
      { kind: 'curve', currency: 'USD', tenorDeltasBps: { '2Y': 50, '10Y': 30 } },
      { kind: 'curve', currency: 'USD', tenorDeltasBps: { '2Y': 25, '30Y': 10 } },
    ]);
    expect((composed[0] as Extract<Shock, { kind: 'curve' }>).tenorDeltasBps).toEqual({
      '2Y': 75,
      '10Y': 30,
      '30Y': 10,
    });
  });

  it('adds credit spreads, vol points and factor sigmas', () => {
    expect(
      (
        compose([
          { kind: 'credit', bucket: 'HY', spreadBps: 120 },
          { kind: 'credit', bucket: 'HY', spreadBps: 80 },
        ])[0] as Extract<Shock, { kind: 'credit' }>
      ).spreadBps,
    ).toBe(200);

    expect(
      (
        compose([
          { kind: 'factor', factor: 'momentum', sigma: -1.5 },
          { kind: 'factor', factor: 'momentum', sigma: -0.5 },
        ])[0] as Extract<Shock, { kind: 'factor' }>
      ).sigma,
    ).toBe(-2);
  });

  it('names which kinds are returns, rather than deciding it inline', () => {
    expect(composesMultiplicatively('equity_index')).toBe(true);
    expect(composesMultiplicatively('fx')).toBe(true);
    expect(composesMultiplicatively('curve')).toBe(false);
    expect(composesMultiplicatively('vol_surface')).toBe(false);
  });

  // Absent and zero are different: a scenario that never touched skew should
  // not start carrying a skew field of 0, which reads as "we shocked it flat".
  it('does not invent a zero on a vol field neither shock set', () => {
    const composed = compose([
      { kind: 'vol_surface', underlying: 'NVDA', parallelVolPts: 4 },
      { kind: 'vol_surface', underlying: 'NVDA', parallelVolPts: 2 },
    ])[0] as Extract<Shock, { kind: 'vol_surface' }>;
    expect(composed.parallelVolPts).toBe(6);
    expect('skewDelta' in composed).toBe(false);
  });

  it('keeps distinct targets apart', () => {
    const composed = compose([
      { kind: 'equity_index', index: 'SPX', pct: -0.05 },
      { kind: 'equity_index', index: 'NDX', pct: -0.08 },
      { kind: 'curve', currency: 'USD', tenorDeltasBps: { '2Y': 50 } },
      { kind: 'curve', currency: 'EUR', tenorDeltasBps: { '2Y': 20 } },
    ]);
    expect(composed).toHaveLength(4);
    expect(composed.map(shockTarget)).toEqual([
      'equity_index:SPX',
      'equity_index:NDX',
      'curve:USD',
      'curve:EUR',
    ]);
  });

  it('reads in the order the analyst built it', () => {
    const composed = compose([
      { kind: 'credit', bucket: 'HY', spreadBps: 100 },
      { kind: 'equity_index', index: 'SPX', pct: -0.05 },
      { kind: 'credit', bucket: 'HY', spreadBps: 50 },
    ]);
    expect(composed.map((s) => s.kind)).toEqual(['credit', 'equity_index']);
  });
});

describe('combining two scenarios', () => {
  // Multiplying two marginals would invent a correlation of zero between
  // exactly the events a scenario grid exists to cross.
  it('does not multiply their probabilities into a joint one', () => {
    const a: Scenario = { ...scenario('a', 'hawkish', []), probability: 0.34 };
    const b: Scenario = { ...scenario('b', 'selloff', []), probability: 0.2 };
    expect(combine(a, b, 'ab').probability).toBeUndefined();
  });

  it('composes the union of their shocks', () => {
    const joint = combine(
      scenario('a', 'hawkish', [{ kind: 'curve', currency: 'USD', tenorDeltasBps: { '2Y': 50 } }]),
      scenario('b', 'steeper', [{ kind: 'curve', currency: 'USD', tenorDeltasBps: { '10Y': 25 } }]),
      'ab',
    );
    expect(joint.shocks).toHaveLength(1);
    expect(joint.name).toBe('hawkish + steeper');
  });

  it('falls back to constructed when the two came from different places', () => {
    const historical: Scenario = { ...scenario('h', 'March 2020', []), source: 'historical_replay' };
    expect(combine(historical, scenario('c', 'hand-built', []), 'x').source).toBe('constructed');
    expect(combine(historical, historical, 'x').source).toBe('historical_replay');
  });
});

describe('historical replay', () => {
  const moves: FactorMove[] = [
    { date: '2020-03-09', target: 'equity_index:SPX', shock: { kind: 'equity_index', index: 'SPX', pct: -0.0760 } },
    { date: '2020-03-12', target: 'equity_index:SPX', shock: { kind: 'equity_index', index: 'SPX', pct: -0.0950 } },
    { date: '2020-03-16', target: 'equity_index:SPX', shock: { kind: 'equity_index', index: 'SPX', pct: -0.1198 } },
    { date: '2020-04-01', target: 'equity_index:SPX', shock: { kind: 'equity_index', index: 'SPX', pct: -0.0446 } },
  ];

  // March 2020 is not one down-move, it is twenty. Summing daily percentage
  // moves overstates the drawdown by several points.
  it('compounds the moves in the window rather than summing them', () => {
    const march = replay(moves, '2020-03-01', '2020-03-31', 'mar20', 'March 2020');
    const pct = (march.shocks[0] as Extract<Shock, { kind: 'equity_index' }>).pct;
    const summed = -0.076 - 0.095 - 0.1198;
    const compounded = (1 - 0.076) * (1 - 0.095) * (1 - 0.1198) - 1;
    expect(pct).toBeCloseTo(compounded, 10);
    expect(pct).toBeGreaterThan(summed);
    // Roughly 2.6 points of difference on three days alone.
    expect((pct - summed) * 100).toBeGreaterThan(2);
  });

  it('respects the window bounds', () => {
    const march = replay(moves, '2020-03-01', '2020-03-31', 'mar20', 'March 2020');
    const all = replay(moves, '2020-01-01', '2020-12-31', 'all', 'all 2020');
    expect(
      (all.shocks[0] as Extract<Shock, { kind: 'equity_index' }>).pct,
    ).toBeLessThan((march.shocks[0] as Extract<Shock, { kind: 'equity_index' }>).pct);
  });

  it('marks the scenario as a replay', () => {
    expect(replay(moves, '2020-03-01', '2020-03-31', 'm', 'March 2020').source).toBe(
      'historical_replay',
    );
  });

  // A scenario named "March 2020" that does nothing is worse than an error: it
  // gets wired into a grid and quietly reports no loss.
  it('throws on an empty window rather than returning a scenario with no shocks', () => {
    expect(() => replay(moves, '2021-01-01', '2021-12-31', 'x', 'nothing')).toThrow(
      EmptyReplayWindow,
    );
  });
});

describe('the grid', () => {
  const rows: GridAxis = {
    name: 'rates',
    points: [
      scenario('r0', 'unchanged', []),
      scenario('r50', '+50bp', [{ kind: 'curve', currency: 'USD', tenorDeltasBps: { '2Y': 50 } }]),
      scenario('r100', '+100bp', [{ kind: 'curve', currency: 'USD', tenorDeltasBps: { '2Y': 100 } }]),
    ],
  };
  const columns: GridAxis = {
    name: 'equity',
    points: [
      scenario('e0', 'flat', []),
      scenario('e10', '-10%', [{ kind: 'equity_index', index: 'SPX', pct: -0.1 }]),
    ],
  };

  /** A book long equity and short duration. */
  const revalue = (shocks: readonly Shock[]) => {
    let value = 1_000_000;
    for (const shock of shocks) {
      if (shock.kind === 'curve') value -= (shock.tenorDeltasBps['2Y'] ?? 0) * 400;
      if (shock.kind === 'equity_index') value += shock.pct * 2_000_000;
    }
    return value;
  };

  it('revalues every cell and states how many that was', () => {
    const grid = evaluateGrid(rows, columns, revalue);
    expect(grid.revaluations).toBe(6);
    expect(grid.cells).toHaveLength(6);
    expect(grid.base).toBe(1_000_000);
  });

  it('composes the row and column scenarios into each cell', () => {
    const grid = evaluateGrid(rows, columns, revalue);
    const corner = grid.cells.find((c) => c.row === 2 && c.column === 1)!;
    expect(corner.scenario.shocks).toHaveLength(2);
    expect(corner.pnl).toBe(-100 * 400 + -0.1 * 2_000_000);
  });

  it('finds the worst and best corners', () => {
    const grid = evaluateGrid(rows, columns, revalue);
    expect(grid.worst.row).toBe(2);
    expect(grid.worst.column).toBe(1);
    expect(grid.best.row).toBe(0);
    expect(grid.best.column).toBe(0);
    expect(grid.best.pnl).toBe(0);
  });

  it('emits a surface shaped rows by columns', () => {
    const surface = toSurface(evaluateGrid(rows, columns, revalue));
    expect(surface).toHaveLength(3);
    expect(surface[0]).toHaveLength(2);
    expect(surface[0]![0]).toBe(0);
    expect(surface[2]![1]).toBe(-240_000);
  });

  // The cheap alternative is a Taylor expansion off the base Greeks, which
  // misses the cross term — and the corner is why the grid was built.
  it('sees a cross term a second-order approximation would miss', () => {
    const crossed = (shocks: readonly Shock[]) => {
      const bp = shocks.find((s) => s.kind === 'curve') as
        | Extract<Shock, { kind: 'curve' }>
        | undefined;
      const eq = shocks.find((s) => s.kind === 'equity_index') as
        | Extract<Shock, { kind: 'equity_index' }>
        | undefined;
      const r = (bp?.tenorDeltasBps['2Y'] ?? 0) / 100;
      const e = eq?.pct ?? 0;
      // A pure cross-gamma term: zero along either axis alone.
      return 1_000_000 + r * e * 5_000_000;
    };
    const grid = evaluateGrid(rows, columns, crossed);
    const alongRates = grid.cells.find((c) => c.row === 2 && c.column === 0)!;
    const alongEquity = grid.cells.find((c) => c.row === 0 && c.column === 1)!;
    const corner = grid.cells.find((c) => c.row === 2 && c.column === 1)!;
    expect(alongRates.pnl).toBe(0);
    expect(alongEquity.pnl).toBe(0);
    expect(corner.pnl).toBe(-500_000);
  });
});

describe('tail attribution', () => {
  // Shares over the summed losses, not the net: a book netting -100 out of a
  // -400 loss against a +300 gain would otherwise report a position losing 200
  // as 200% of the loss.
  it('takes shares over the losses, not the net', () => {
    const contributions = tailContributors(
      new Map([
        ['jan-calls', -240],
        ['calendar', -160],
        ['software', +300],
      ]),
    );
    expect(contributions).toHaveLength(2);
    expect(contributions[0]?.positionId).toBe('jan-calls');
    expect(contributions[0]?.share).toBeCloseTo(0.6, 10);
    expect(contributions[1]?.share).toBeCloseTo(0.4, 10);
    expect(contributions.reduce((t, c) => t + c.share, 0)).toBeCloseTo(1, 10);
  });

  it('returns the three largest losers by default', () => {
    const contributions = tailContributors(
      new Map([['a', -10], ['b', -50], ['c', -30], ['d', -5]]),
    );
    expect(contributions.map((c) => c.positionId)).toEqual(['b', 'c', 'a']);
  });

  it('reports nothing when nothing lost', () => {
    expect(tailContributors(new Map([['a', 10]]))).toEqual([]);
  });
});
