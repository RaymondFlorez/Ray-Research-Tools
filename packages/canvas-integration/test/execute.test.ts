/**
 * A model's plan, approved, executed by real agents (PRD 4.5, 5.7).
 *
 * The seam: canvas-agents reads the plan and runs it, canvas-data serves the
 * facts at a knowledge time under entitlements, canvas-pricing computes
 * through the Rust core's WASM build. Each figure the agents put on the board
 * is checked against something they do not compute: a bond paying the curve's
 * own par coupon is worth par, a shock's P&L is close to minus its DV01 times
 * the move, an options book at today's market is the sum of its legs priced
 * one at a time.
 *
 * The yields are illustrative, not a published curve; `scripts/execute-live.mjs`
 * runs the same plan against Treasury's own figures through the Go data plane.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  approve,
  Blackboard,
  bookGridAgent,
  curveShockAgent,
  factId,
  plan,
  PlanNotRunnable,
  readPlan,
  retrievalAgent,
  run,
  scope,
  toPlanSteps,
} from '@picasso/canvas-agents';
import { classifiedSource, type ClassifiedFact } from '@picasso/canvas-data';
import { BondAnalytics, CurveEngine, GridPricer, Pricer, type CashFlow, type Leg } from '@picasso/canvas-pricing';
import { loadPricing } from './load.js';

const CURVE: Array<[string, number, number]> = [
  ['UST.par.3M', 0.25, 4.32], ['UST.par.6M', 0.5, 4.25], ['UST.par.1Y', 1, 4.1], ['UST.par.2Y', 2, 3.95],
  ['UST.par.5Y', 5, 4.02], ['UST.par.10Y', 10, 4.3], ['UST.par.30Y', 30, 4.6],
];
const facts: ClassifiedFact[] = [
  ...CURVE.map(([key, , value]) => ({ key, validTime: '2026-11-25', knowledgeTime: '2026-11-26T05:00:00Z', value, dataClass: 'public' as const, source: 'illustrative' })),
  { key: 'XYZ.close', validTime: '2026-11-25', knowledgeTime: '2026-11-25T21:00:00Z', value: 101.25, dataClass: 'public', source: 'illustrative' },
];
const source = classifiedSource(facts, { userId: 'pm', tenantId: 't', vendors: new Set(), positions: true, mnpi: false });
const KNOWN = '2026-11-27T00:00:00Z';

/** A bond paying `pct` twice a year to `years`, per 100 of face. */
const parBond = (years: number, pct: number): CashFlow[] =>
  Array.from({ length: years * 2 }, (_, i) => [(i + 1) / 2, pct / 2 + (i + 1 === years * 2 ? 100 : 0)] as CashFlow);

// What a model sent back for the question, as plan-live reads it.
const MODEL_REPLY = `{"steps": [
  {"id": "rates", "kind": "retrieval", "agent": "retriever", "description": "read the Treasury par curve", "dependsOn": []},
  {"id": "sleeve", "kind": "compute", "agent": "simulator", "description": "reprice the bond sleeve under +50bp", "dependsOn": ["rates"]}
]}`;

let exportsReady: Awaited<ReturnType<typeof loadPricing>>;
beforeAll(async () => {
  exportsReady = await loadPricing();
});

describe('a model\'s plan runs on real agents once approved', () => {
  it('reprices the sleeve on the bootstrapped curve, and each figure checks against what the agents did not compute', async () => {
    const curves = new CurveEngine(exportsReady);
    const book = [
      { id: 'two', flows: parBond(2, 3.95), quantity: 1_000 },
      { id: 'ten', flows: parBond(10, 4.3), quantity: 500 },
    ];
    const read = readPlan(MODEL_REPLY, { estimate: () => ({ cents: 0, ms: 50 }) });
    expect(read.problems).toEqual([]);
    const shown = plan({ scope: scope({ question: 'What happens to the bond sleeve if rates rise 50bp?', resolve: () => [] }), author: { kind: 'model', model: 'qwen2.5-1.5b' }, steps: read.steps });
    expect(() => toPlanSteps(shown)).toThrow(PlanNotRunnable);

    const approved = approve(shown, { user: 'pm', at: '2026-11-28T09:00:00Z' });
    const board = new Blackboard('sleeve', approved.question, 10);
    board.setPlan(toPlanSteps(approved));
    const result = await run({
      board,
      agents: {
        rates: retrievalAgent({ source, knowledgeTime: KNOWN, keys: CURVE.map(([key]) => ({ key, unit: 'pct' })) }),
        sleeve: curveShockAgent({ curves, points: CURVE.map(([key, years]) => ({ key, years })), book, shock: { shape: 'parallel', bps: 50 } }),
      },
    });
    expect(result.completed).toEqual(['rates', 'sleeve']);
    expect(result.failed).toEqual([]);

    const base = board.fact('sleeve:base')!.value!.number;
    const shocked = board.fact('sleeve:shocked')!.value!.number;
    const pnl = board.fact('sleeve:pnl')!;
    // Coupons on the bootstrap's own dates at its own par rates: worth par.
    expect(base).toBeCloseTo(150_000, 6);
    expect(pnl.value!.number).toBe(shocked - base);
    expect(pnl.derivation).toEqual({ op: 'difference', operands: ['sleeve:shocked', 'sleeve:base'] });
    expect(pnl.provenance).toMatchObject({ kind: 'cell', nodeId: 'sleeve/sleeve', port: 'pnl' });

    // Against duration, which the bond analytics compute from yield, not from the curve.
    const bonds = new BondAnalytics(exportsReady, curves);
    const dv01 = book.reduce((total, b) => total + b.quantity * bonds.yieldMetrics(b.flows, 100)!.dv01, 0);
    expect(pnl.value!.number).toBeLessThan(0);
    // Measured at 1.0025: the curve's parallel move and a yield's are not the same move.
    expect(Math.abs(pnl.value!.number / (-dv01 * 50) - 1)).toBeLessThan(0.005);
    expect(board.step('sleeve')?.note).toMatch(/^bootstrapped 7 par yields \(worst residual .*bp\) and repriced 2 bond\(s\)$/);
  });

  it('prices an options book at the market it retrieved, equal to its legs priced one at a time', async () => {
    const legs: Leg[] = [
      { strike: 100, time: 0.5, kind: 'call', style: 'european', quantity: 10, multiplier: 100, vol: 0.3 },
      { strike: 95, time: 0.25, kind: 'put', style: 'european', quantity: -5, multiplier: 100, vol: 0.32 },
    ];
    const board = new Blackboard('book', 'value the book', 10);
    const shown = plan({
      scope: scope({ question: 'value the book', resolve: () => [] }),
      author: { kind: 'analyst', user: 'pm' },
      steps: [
        { id: 'market', kind: 'retrieval', agent: 'retriever', description: 'spot and the 3M bill', dependsOn: [], estimatedCents: 0, estimatedMs: 50 },
        { id: 'book', kind: 'compute', agent: 'quant', description: 'reprice the book', dependsOn: ['market'], estimatedCents: 0, estimatedMs: 50 },
      ],
    });
    board.setPlan(toPlanSteps(shown));
    const result = await run({
      board,
      agents: {
        market: retrievalAgent({ source, knowledgeTime: KNOWN, keys: [{ key: 'XYZ.close', unit: 'usd' }, { key: 'UST.par.3M', unit: 'pct' }] }),
        book: bookGridAgent({ pricer: new GridPricer(exportsReady), book: legs, market: { spot: 'XYZ.close', rate: 'UST.par.3M' }, grid: { spotSteps: 25, spotRange: 0.2, volSteps: 15, volRange: 0.1 } }),
      },
    });
    expect(result.completed).toEqual(['market', 'book']);
    const pricer = new Pricer(exportsReady);
    const one = (leg: Leg) => pricer.greeks({ spot: 101.25, strike: leg.strike, time: leg.time, rate: 0.0432, dividend: 0, vol: leg.vol, kind: leg.kind });
    const expected = legs.reduce((t, l) => ({ value: t.value + one(l).price * l.quantity * l.multiplier, delta: t.delta + one(l).delta * l.quantity * l.multiplier }), { value: 0, delta: 0 });
    expect(board.fact('book:value')!.value!.number).toBeCloseTo(expected.value, 9);
    expect(board.fact('book:delta')!.value!.number).toBeCloseTo(expected.delta, 9);
    expect(board.fact(factId('market', 'XYZ.close'))!.provenance).toMatchObject({ kind: 'cell', nodeId: 'market/XYZ.close' });
  });
});
