import { beforeAll, describe, expect, it } from 'vitest';
import {
  addNode,
  createDocument,
  deriveCacheKey,
  schedule,
  validateConnection,
  createNode,
} from '@picasso/canvas-core';
import { GridPricer, type Leg, type Market } from '../src/grid.js';
import {
  atTheMoney,
  createStrategyNode,
  evaluateStrategy,
  readBook,
  strategyPorts,
} from '../src/strategy.js';
import { loadPricing } from './load.js';

let pricer: GridPricer;

beforeAll(async () => {
  pricer = new GridPricer(await loadPricing());
});

const market: Market = { spot: 100, rate: 0.045, dividend: 0.017 };

/** A risk reversal: long the 110 call, short the 90 put. */
const riskReversal: Leg[] = [
  { strike: 110, time: 0.5, kind: 'call', style: 'american', quantity: 20, multiplier: 100, vol: 0.26 },
  { strike: 90, time: 0.5, kind: 'put', style: 'american', quantity: -20, multiplier: 100, vol: 0.31 },
];

describe('a strategy on the canvas', () => {
  it('computes a surface and records what it cost', () => {
    const node = createStrategyNode({ id: 'rr', legs: riskReversal, market });
    expect(node.state.status).toBe('stale');

    const evaluation = evaluateStrategy(node, pricer, () => 1_700_000);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;

    expect(node.state.status).toBe('ready');
    expect(node.state.lastComputedAt).toBe(1_700_000);
    expect(node.state.latencyMs).toBeGreaterThan(0);
    expect(evaluation.result.cells).toHaveLength(375);

    // Long the upside, short the downside: delta is positive at the money.
    expect(atTheMoney(evaluation.result).delta).toBeGreaterThan(0);
  });

  it('leaves a sketch alone: a loose strategy is a drawing, not a computation', () => {
    const node = createStrategyNode({ id: 'sketch', legs: riskReversal, market, binding: 'loose' });
    expect(node.state.status).toBe('idle');

    const evaluation = evaluateStrategy(node, pricer);
    expect(evaluation.ok).toBe(false);
    if (evaluation.ok) return;
    expect(evaluation.reason).toBe('loose');
    // Untouched: no cost, no spinner, no error badge.
    expect(node.state.status).toBe('idle');
    // And the scheduler would never have offered it in the first place.
    const doc = createDocument('book');
    addNode(doc, node);
    expect(schedule(doc, { visible: ['sketch'] }).order).not.toContain('sketch');
  });

  it('says what is wrong with an empty book instead of drawing an empty surface', () => {
    const node = createStrategyNode({ id: 'empty', legs: [], market });
    const evaluation = evaluateStrategy(node, pricer);
    expect(evaluation.ok).toBe(false);
    expect(node.state.status).toBe('error');
    expect(node.state.error?.code).toBe('empty_book');
    expect(node.state.error?.retriable).toBe(false);
  });

  it('round-trips the book through params without losing a leg', () => {
    const node = createStrategyNode({ id: 'rr', legs: riskReversal, market });
    expect(readBook(node).legs).toEqual(riskReversal);
    expect(readBook(node).market).toEqual(market);
    expect(readBook(node).grid.spotSteps).toBe(25);
  });
});

describe('the book is part of the cache key', () => {
  function keyFor(legs: Leg[]): string | undefined {
    const doc = createDocument('book');
    addNode(doc, createStrategyNode({ id: 'rr', legs, market }));
    return deriveCacheKey(doc, 'rr');
  }

  it('changes when a leg changes', () => {
    const base = keyFor(riskReversal);
    expect(base).toBeDefined();
    const resized = riskReversal.map((leg, i) => (i === 0 ? { ...leg, quantity: 21 } : leg));
    expect(keyFor(resized)).not.toBe(base);
  });

  it('does not change when the same book is rebuilt', () => {
    expect(keyFor(riskReversal.map((leg) => ({ ...leg })))).toBe(keyFor(riskReversal));
  });

  it('changes when the grid changes, because the cells do', () => {
    const doc = createDocument('book');
    addNode(doc, createStrategyNode({ id: 'rr', legs: riskReversal, market }));
    const base = deriveCacheKey(doc, 'rr');

    const wider = createDocument('book');
    addNode(wider, createStrategyNode({
      id: 'rr', legs: riskReversal, market,
      grid: { spotSteps: 25, spotRange: 0.4, volSteps: 15, volRange: 0.1 },
    }));
    expect(deriveCacheKey(wider, 'rr')).not.toBe(base);
  });
});

describe('the surface output wires into the rest of the canvas', () => {
  it('feeds a SurfaceNode', () => {
    const strategy = createStrategyNode({ id: 'rr', legs: riskReversal, market });
    const chart = createNode({
      id: 'heat',
      kind: 'SurfaceNode',
      binding: 'wired',
      inputs: [{ id: 'z', name: 'Surface', type: 'surface', cardinality: 'one', required: true }],
    });
    const result = validateConnection(strategy, 'pnl', chart, 'z');
    expect(result.ok).toBe(true);
  });

  it('declares the ports the PRD gives a StrategyNode', () => {
    const ports = strategyPorts();
    expect(ports.outputs.map((p) => p.type)).toEqual(['surface', 'portfolio']);
    expect(ports.inputs.find((p) => p.id === 'underlier')?.required).toBe(true);
  });
});
