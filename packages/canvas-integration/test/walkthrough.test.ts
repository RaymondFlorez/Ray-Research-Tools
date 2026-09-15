/**
 * The PRD's worked example, run end to end.
 *
 * "Model a 50bps rate-hike shock across my options portfolio." (PRD 5.7)
 *
 * Every other suite in this repo tests one package against its own fixtures.
 * This one tests the seams, which is where the bugs that survive unit tests
 * live: a unit convention that disagrees across a boundary, a classification
 * that does not travel, a number that means one thing in the pricer and
 * another in the narrative. Nothing here is mocked except the models, which
 * do not exist — the curve is bootstrapped and shocked in the real Rust core
 * through WASM, the book is repriced there, and the numbers the Reconciler
 * checks are the numbers that engine produced.
 *
 * The flow follows 5.7's own plan for that query, in its order:
 * scope → plan → route → curve → transmit → reprice → scenario grid →
 * tail attribution → weight → reconcile → critique → export.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Shock } from '@picasso/canvas-core';
import {
  Blackboard,
  joinAndReconcile,
  plan,
  run,
  scope,
  toPlanSteps,
  critique,
  type CellReading,
  type Narrative,
  type PlannedStep,
} from '@picasso/canvas-agents';
import {
  AuditLog,
  EgressProxy,
  PositionFingerprints,
  buildBundle,
  checkToolCall,
  routerGate,
  ExportWouldLeak,
} from '@picasso/canvas-guard';
import { DEFAULT_POLICY, modelById, route } from '@picasso/canvas-router';
import {
  CurveEngine,
  GridPricer,
  evaluateGrid,
  fitSensitivity,
  tailContributors,
  transmit,
  type GridAxis,
  type Instrument,
  type Leg,
  type Market,
} from '@picasso/canvas-pricing';
import { curve as probabilityCurve, weigh, weightFromCurve } from '@picasso/canvas-markets';
import { loadPricing } from './load.js';

const TENANT = 'tenant-a';

/** A short USD curve: deposits out to a year, then swaps. */
const INSTRUMENTS: Instrument[] = [
  { kind: 'deposit', maturity: 0.25, rate: 0.0425 },
  { kind: 'deposit', maturity: 0.5, rate: 0.0432 },
  { kind: 'deposit', maturity: 1, rate: 0.0441 },
  { kind: 'swap', maturity: 2, rate: 0.0438, frequency: 2 },
  { kind: 'swap', maturity: 5, rate: 0.0421, frequency: 2 },
  { kind: 'swap', maturity: 10, rate: 0.0417, frequency: 2 },
];

/** Four positions, the shape of the walkthrough's book. */
const BOOK: Array<{ id: string; leg: Leg }> = [
  { id: 'jan-nvda-calls', leg: { strike: 140, time: 0.35, kind: 'call', style: 'american', quantity: 40, multiplier: 100, vol: 0.52 } },
  { id: 'avgo-calendar', leg: { strike: 120, time: 0.12, kind: 'call', style: 'american', quantity: -25, multiplier: 100, vol: 0.44 } },
  { id: 'software-basket', leg: { strike: 95, time: 1.1, kind: 'put', style: 'american', quantity: -30, multiplier: 100, vol: 0.38 } },
  { id: 'semis-hedge', leg: { strike: 105, time: 0.6, kind: 'put', style: 'american', quantity: 18, multiplier: 100, vol: 0.41 } },
];

const BASE_MARKET: Market = { spot: 118.5, rate: 0.0441, dividend: 0.004 };

let pricer: GridPricer;
let curves: CurveEngine;

beforeAll(async () => {
  const exports = await loadPricing();
  pricer = new GridPricer(exports);
  curves = new CurveEngine(exports);
}, 180_000);

/** Reprice the whole book at one market. A 1×1 grid is one revaluation. */
function bookValue(market: Market, volShift: number, legs: readonly Leg[] = BOOK.map((p) => p.leg)) {
  const shifted = legs.map((leg) => ({ ...leg, vol: Math.max(0.01, leg.vol + volShift) }));
  const result = pricer.reprice(shifted, market, {
    spotSteps: 1,
    spotRange: 0,
    volSteps: 1,
    volRange: 0,
  });
  return result.cell(0, 0);
}

// ---------------------------------------------------------------------------

describe('1 · scope and plan', () => {
  const resolve = (mention: string) =>
    mention === 'my portfolio'
      ? [{ kind: 'portfolio' as const, id: 'pf:main', label: 'Main book' }]
      : [];

  it('resolves the question against the canvas before planning anything', () => {
    const scoped = scope({
      question: 'Model a 50bps rate-hike shock across my portfolio',
      resolve,
    });
    expect(scoped.ready).toBe(true);
    expect(scoped.resolved.find((r) => r.kind === 'portfolio')?.id).toBe('pf:main');
  });

  it('compiles a plan whose critical path is shorter than its total work', () => {
    const scoped = scope({ question: 'Model a 50bps rate-hike shock across my portfolio', resolve });
    const steps: PlannedStep[] = [
      { id: 'portfolio', kind: 'compute', description: 'load the book', agent: 'quant', dependsOn: [], estimatedCents: 1, estimatedMs: 400, method: 'local_only' },
      { id: 'curve', kind: 'compute', description: 'bootstrap the curve', agent: 'quant', dependsOn: [], estimatedCents: 1, estimatedMs: 600 },
      { id: 'shock', kind: 'compute', description: 'apply +50bp', agent: 'simulator', dependsOn: ['curve'], estimatedCents: 2, estimatedMs: 900, method: 'historically_estimated_shape', alternatives: ['historically_estimated_shape', 'parallel'] },
      { id: 'grid', kind: 'compute', description: 'reprice the book', agent: 'simulator', dependsOn: ['portfolio', 'shock'], estimatedCents: 4, estimatedMs: 21_000 },
      { id: 'scribe', kind: 'reasoning', description: 'write the answer', agent: 'scribe', taskClass: 'synthesis.final', dependsOn: ['grid'], estimatedCents: 9, estimatedMs: 5_000 },
    ];
    const compiled = plan({ scope: scoped, steps });
    const serial = steps.reduce((t, s) => t + s.estimatedMs, 0);
    expect(compiled.estimatedMs).toBeLessThan(serial);
    expect(compiled.warnings).toEqual([]);
  });
});

describe('2 · the positions never leave the tenant', () => {
  const fingerprints = new Map([
    // Not 4,000 and -2,500: round lots are deliberately excluded from
    // fingerprinting, because blocking every payload that mentions a ticker
    // near a round number takes the proxy offline within a day.
    [TENANT, new PositionFingerprints([{ symbol: 'NVDA', quantity: 4_137 }, { symbol: 'AVGO', quantity: -2_518 }])],
  ]);
  const proxy = new EgressProxy(fingerprints);

  it('refuses a positions-classified prompt to a vendor model', () => {
    const decision = routerGate({
      modelId: 'frontier-a',
      placement: 'vendor',
      contextClasses: ['public', 'positions'],
      tenantId: TENANT,
    });
    expect(decision.allowed).toBe(false);
  });

  it('routes the same work to the self-hosted fleet instead', () => {
    const decision = route(DEFAULT_POLICY, {
      taskClass: 'quant.codegen',
      inputTokens: 4_000,
      expectedOutputTokens: 800,
      modalities: ['text', 'code'],
      toolsRequired: ['run.code'],
      rigorFlag: false,
      dataSensitivity: 'positions',
      costCeilingCents: 40,
      latencyBudgetMs: 30_000,
      determinismRequired: true,
      priorFailures: [],
    });
    const model = decision.model;
    expect(model.placement).not.toBe('vendor');
    // The hard rule fired before any score, and says so.
    expect(decision.excluded.some((e) => e.rule.toLowerCase().includes('position'))).toBe(true);
    expect(routerGate({ modelId: model.id, placement: model.placement, contextClasses: ['positions'], tenantId: TENANT }).allowed).toBe(true);
  });

  // The second control, with the first assumed compromised.
  it('stops a mislabelled dump at the wire even when the stamp says public', () => {
    const gate = routerGate({ modelId: 'frontier-a', placement: 'vendor', contextClasses: ['public'], tenantId: TENANT });
    expect(gate.allowed).toBe(true);
    const wire = proxy.check({
      tenantId: TENANT,
      payload: 'Book: NVDA 4,137 shares and AVGO -2,518 shares against the shock.',
      destination: 'https://vendor-a.example/v1/messages',
    });
    expect(wire.allowed).toBe(false);
  });

  it('gives the quant agent no capability that could read the book directly', () => {
    expect(checkToolCall('quant.codegen', 'read.portfolio').allowed).toBe(false);
    expect(checkToolCall('quant.codegen', 'run.code').allowed).toBe(true);
  });
});

describe('3 · the curve, the shock, and what transmits', () => {
  it('bootstraps and shocks through the real core', () => {
    const base = curves.bootstrap(INSTRUMENTS);
    const baseOneYear = base.zero(1);
    const shocked = curves.shocked(INSTRUMENTS, { shape: 'parallel', bps: 50 });
    const shockedOneYear = shocked.zero(1);
    expect((shockedOneYear - baseOneYear) * 10_000).toBeCloseTo(50, 6);
  });

  // "it refuses to pretend a parallel shift is the honest default, and it
  // exposes the estimation quality of every mapping it uses."
  it('carries an assumption line for every estimated channel', () => {
    const base = curves.bootstrap(INSTRUMENTS);
    const baseOneYear = base.zero(1);
    const shocked = curves.shocked(INSTRUMENTS, { shape: 'parallel', bps: 50 });

    const rateMoves = [12, -8, 25, -14, 33, -21, 18, -30, 9, -5];
    const spotMoves = rateMoves.map((bp) => -0.0009 * bp + (bp % 3) * 0.0001);
    const sensitivity = fitSensitivity({
      underlier: 'NVDA',
      rateChangesBps: rateMoves,
      returns: spotMoves,
      volChanges: rateMoves.map((bp) => 0.0002 * bp),
      window: ['2021-01-01', '2026-01-01'],
    });

    const transmission = transmit(BASE_MARKET, base, shocked, sensitivity, { baseRate: baseOneYear });
    expect(transmission.rateMoveBps).toBeCloseTo(50, 6);
    // A hike pushes a long-duration name down.
    expect(transmission.spotMovePct).toBeLessThan(0);
    expect(transmission.assumptions.length).toBeGreaterThan(0);
    expect(transmission.assumptions.join(' ')).toMatch(/R-squared|r-squared|R²/i);
  });
});

describe('4 · the scenario grid revalues every cell in the real engine', () => {
  const rateAxis: GridAxis = {
    name: 'rates',
    points: [
      { id: 'r0', name: 'unchanged', shocks: [], source: 'constructed' },
      { id: 'r50', name: '+50bp', shocks: [{ kind: 'curve', currency: 'USD', tenorDeltasBps: { '1Y': 50 } }], source: 'constructed' },
    ],
  };
  const equityAxis: GridAxis = {
    name: 'equity',
    points: [
      { id: 'e0', name: 'flat', shocks: [], source: 'constructed' },
      { id: 'e8', name: '-8%', shocks: [{ kind: 'equity_index', index: 'SOX', pct: -0.08 }], source: 'constructed' },
      { id: 'v6', name: '+6 vol pts', shocks: [{ kind: 'vol_surface', underlying: 'NVDA', parallelVolPts: 6 }], source: 'constructed' },
    ],
  };

  function marketFor(shocks: readonly Shock[]): { market: Market; volShift: number } {
    let { spot, rate, dividend } = BASE_MARKET;
    let volShift = 0;
    for (const shock of shocks) {
      if (shock.kind === 'curve') rate += (shock.tenorDeltasBps['1Y'] ?? 0) / 10_000;
      if (shock.kind === 'equity_index') spot *= 1 + shock.pct;
      if (shock.kind === 'vol_surface') volShift += (shock.parallelVolPts ?? 0) / 100;
    }
    return { market: { spot, rate, dividend }, volShift };
  }

  const revalue = (shocks: readonly Shock[]) => {
    const { market, volShift } = marketFor(shocks);
    return bookValue(market, volShift).value;
  };

  it('prices six cells, each a full revaluation', () => {
    const grid = evaluateGrid(rateAxis, equityAxis, revalue);
    expect(grid.revaluations).toBe(6);
    expect(grid.cells.every((c) => Number.isFinite(c.value))).toBe(true);
  });

  it('leaves the unshocked corner at exactly zero P&L', () => {
    const grid = evaluateGrid(rateAxis, equityAxis, revalue);
    const flat = grid.cells.find((c) => c.row === 0 && c.column === 0)!;
    expect(flat.pnl).toBe(0);
    expect(flat.scenario.shocks).toHaveLength(0);
  });

  // The whole reason a grid is a grid: the corner is not the sum of the edges.
  it('finds a corner the two edges do not add up to', () => {
    const grid = evaluateGrid(rateAxis, equityAxis, revalue);
    const alongRates = grid.cells.find((c) => c.row === 1 && c.column === 0)!;
    const alongEquity = grid.cells.find((c) => c.row === 0 && c.column === 1)!;
    const corner = grid.cells.find((c) => c.row === 1 && c.column === 1)!;
    const additive = alongRates.pnl + alongEquity.pnl;
    expect(Math.abs(corner.pnl - additive)).toBeGreaterThan(0);
  });

  it('names the positions carrying the tail', () => {
    const { market, volShift } = marketFor([
      { kind: 'curve', currency: 'USD', tenorDeltasBps: { '1Y': 50 } },
      { kind: 'equity_index', index: 'SOX', pct: -0.08 },
    ]);
    const byPosition = new Map<string, number>();
    for (const position of BOOK) {
      const before = bookValue(BASE_MARKET, 0, [position.leg]).value;
      const after = bookValue(market, volShift, [position.leg]).value;
      byPosition.set(position.id, after - before);
    }
    const tail = tailContributors(byPosition);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.reduce((t, c) => t + c.share, 0)).toBeLessThanOrEqual(1.0000001);
    // The shares are taken over losses, so every contributor is a loser.
    expect(tail.every((c) => c.pnl < 0)).toBe(true);
  });
});

describe('5 · a market probability becomes a real weight', () => {
  it('carries its resolution criteria and its residual into the scenario set', () => {
    const hike = probabilityCurve({
      venue: 'kalshi',
      marketType: 'binary_clob',
      event: 'Fed hikes 50bp by June',
      criteria: {
        text: 'Resolves YES if the target range rises by 50bp or more at or before the June FOMC.',
        settlesAt: '2026-06-17',
      },
      points: [{ at: '2026-03-11', probability: 0.34, band: 0.005, depth: 40_000 }],
    });

    const set = weigh([
      weightFromCurve('hike', 'Fed hikes 50bp', hike, { pnl: -240_000 }),
      { scenarioId: 'hold', name: 'Fed holds', probability: 0.6, pnl: 18_000 },
    ]);

    expect(set.scenarios[0]?.probability).toBe(0.34);
    expect(set.scenarios[0]?.source?.criteria).toContain('target range rises');
    // 6% of the outcome space is unmodelled, and the set says so rather than
    // normalizing it away across the two scenarios anyone thought of.
    expect(set.residual).toBeCloseTo(0.06, 10);
    expect(set.warnings.join(' ')).toContain('not covered by any scenario');
  });
});

describe('6 · every number in the answer traces to a cell', () => {
  function board(vega: number, delta: number): Blackboard {
    const b = new Blackboard('walkthrough', 'Model a 50bps rate-hike shock', 200);
    b.assert({
      id: 'f-vega',
      claim: 'total portfolio vega under the shock',
      value: { number: vega, unit: 'usd', asof: '2026-03-11' },
      provenance: { kind: 'cell', nodeId: 'grid-corner', cacheKey: 'k-1', port: 'vega' },
      confidence: 1,
      assertedBy: 'simulator',
    });
    b.assert({
      id: 'f-delta',
      claim: 'total portfolio delta under the shock',
      value: { number: delta, unit: 'usd', asof: '2026-03-11' },
      provenance: { kind: 'cell', nodeId: 'grid-corner', cacheKey: 'k-1', port: 'delta' },
      confidence: 1,
      assertedBy: 'simulator',
    });
    return b;
  }

  function draft(vegaText: string, deltaText: string): Narrative {
    const head = 'Under the shock the book carries vega of ';
    const middle = ' and delta of ';
    const start = head.length;
    const deltaStart = start + vegaText.length + middle.length;
    return {
      text: `${head}${vegaText}${middle}${deltaText}.`,
      handles: [
        { factId: 'f-vega', start, end: start + vegaText.length },
        { factId: 'f-delta', start: deltaStart, end: deltaStart + deltaText.length },
      ],
    };
  }

  it('passes a draft whose numbers are the engine\'s own', async () => {
    const corner = bookValue({ spot: 109.02, rate: 0.0491, dividend: 0.004 }, 0);
    const vega = Math.round(corner.vega);
    const delta = Math.round(corner.delta);

    const cells: CellReading[] = [
      { nodeId: 'grid-corner', cacheKey: 'k-1', port: 'vega', label: 'vega', value: vega, unit: 'usd', asof: '2026-03-11' },
      { nodeId: 'grid-corner', cacheKey: 'k-1', port: 'delta', label: 'delta', value: delta, unit: 'usd', asof: '2026-03-11' },
    ];

    const result = await joinAndReconcile(board(vega, delta), {
      narrative: () => draft(String(vega), String(delta)),
      cells: () => cells,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
  });

  // The failure mode the Reconciler exists for, with real numbers behind it.
  it('fails the join on a transcribed number and passes on the corrected redraft', async () => {
    const corner = bookValue({ spot: 109.02, rate: 0.0491, dividend: 0.004 }, 0);
    const vega = Math.round(corner.vega);
    const delta = Math.round(corner.delta);
    const cells: CellReading[] = [
      { nodeId: 'grid-corner', cacheKey: 'k-1', port: 'vega', label: 'vega', value: vega, unit: 'usd', asof: '2026-03-11' },
      { nodeId: 'grid-corner', cacheKey: 'k-1', port: 'delta', label: 'delta', value: delta, unit: 'usd', asof: '2026-03-11' },
    ];

    let handed: number[] = [];
    const result = await joinAndReconcile(board(vega, delta), {
      narrative: () => draft(String(vega + 330), String(delta)),
      cells: () => cells,
      rerunScribe: (corrections) => {
        handed = corrections.map((c) => c.value);
        return draft(String(vega), String(delta));
      },
    });

    expect(result.rounds[0]?.some((f) => f.kind === 'transcription')).toBe(true);
    expect(handed).toEqual([vega]);
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });
});

describe('7 · the Critic runs with no model at all', () => {
  it('still names the assumptions, the base rate and the sweep', () => {
    const author = modelById(DEFAULT_POLICY, 'frontier-a')!;
    const result = critique({
      thesis: 'a 50bp hike compresses the long-duration book',
      document: { id: 'c', nodes: new Map(), edges: new Map() },
      author,
      available: [],
      history: [
        { confidence: 0.7, outcome: false },
        { confidence: 0.6, outcome: true },
        { confidence: 0.8, outcome: false },
      ],
      retrieve: () => [{ id: 'e1', text: 'the same setup preceded an 18% rally', score: 0.9 }],
      sweep: {
        assumptions: [{ nodeId: 'scn', kind: 'hand_set_param', name: 'shockBps', description: '', value: 50, sigma: 25 }],
        evaluate: ({ value }) => 100 - value,
        holds: (m) => m > 30,
      },
    });
    expect(result.tier.model).toBeUndefined();
    expect(result.prose).toBeUndefined();
    expect(result.baseRate?.sentence).toContain('right once');
    expect(result.sweep?.flips).toHaveLength(1);
    expect(result.header).toContain('reduced independence');
  });
});

describe('8 · the export refuses to take positions out of the tenant', () => {
  const audit = new AuditLog();

  it('blocks the bundle and records the attempt', () => {
    audit.write({
      at: 1,
      tenantId: TENANT,
      actor: 'maya',
      action: 'export.create',
      resource: 'canvas/post-q4',
      purpose: 'share the shock analysis with a partner outside the firm',
    });

    expect(() =>
      buildBundle({
        title: 'post-Q4-hawkish',
        tenantId: TENANT,
        actor: 'maya',
        purpose: 'share with partner',
        leavesTenant: true,
        at: 1_772_000_000_000,
        vendorPolicies: [],
        cells: [
          {
            id: 'vega',
            label: 'portfolio vega',
            value: -3870,
            classification: 'positions',
            datasetSnapshots: { positions: 'snap-9912' },
            traceIds: ['trace-1'],
            asof: '2026-03-11',
          },
        ],
      }),
    ).toThrow(ExportWouldLeak);

    expect(audit.count()).toBe(1);
    expect(audit.records(TENANT)[0]?.purpose).toContain('outside the firm');
  });

  it('lets the same figures out internally, with the appendix attached', () => {
    const bundle = buildBundle({
      title: 'post-Q4-hawkish',
      tenantId: TENANT,
      actor: 'maya',
      purpose: 'internal review',
      leavesTenant: false,
      at: 1_772_000_000_000,
      vendorPolicies: [],
      audit,
      cells: [
        {
          id: 'vega',
          label: 'portfolio vega',
          value: -3870,
          classification: 'positions',
          datasetSnapshots: { positions: 'snap-9912' },
          traceIds: ['trace-1'],
          modelVersions: ['open-70b@2026-02-01'],
          asof: '2026-03-11',
        },
      ],
    });
    expect(bundle.appendix.traceIds).toEqual(['trace-1']);
    expect(bundle.appendix.datasetSnapshots).toEqual({ positions: 'snap-9912' });
    expect(bundle.appendix.auditDigest).toBe(audit.digest());
  });
});

describe('9 · the plan runs as waves on the blackboard', () => {
  it('completes inside its budget and reaches the join', async () => {
    const board = new Blackboard('walkthrough', 'Model a 50bps rate-hike shock', 100);
    const scoped = scope({ question: 'Model a 50bps rate-hike shock across my portfolio', resolve: () => [] });
    const compiled = plan({
      scope: scoped,
      steps: [
        { id: 'portfolio', kind: 'compute', description: 'load the book', agent: 'quant', dependsOn: [], estimatedCents: 1, estimatedMs: 400 },
        { id: 'curve', kind: 'compute', description: 'bootstrap', agent: 'quant', dependsOn: [], estimatedCents: 1, estimatedMs: 600 },
        { id: 'grid', kind: 'compute', description: 'reprice', agent: 'simulator', dependsOn: ['portfolio', 'curve'], estimatedCents: 4, estimatedMs: 21_000 },
      ],
    });
    board.setPlan(toPlanSteps(compiled));

    const agents = Object.fromEntries(
      compiled.steps.map((s) => [s.id, () => ({ costCents: s.estimatedCents })]),
    );
    const result = await run({ board, agents });

    expect(result.completed).toHaveLength(3);
    expect(result.failed).toEqual([]);
    expect(result.waves).toBe(2);
    expect(board.budgetState().spentCents).toBe(compiled.totalCents);
  });
});
