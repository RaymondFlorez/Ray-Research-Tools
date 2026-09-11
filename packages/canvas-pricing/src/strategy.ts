/**
 * The StrategyNode: a book of legs on the canvas that computes through WASM.
 *
 * PRD 3.3 lists `StrategyNode` among the compute kinds and 5.4 says what it
 * does. This is where the pricing core stops being a library and becomes a node
 * in the DAG: it takes an instrument and a market, emits a `surface` and a
 * `portfolio`, and carries the guard's badge in its runtime state so the
 * analyst can see which of the two answers they are looking at.
 *
 * Two properties the rest of the canvas depends on:
 *
 *  - **Params are the book.** The legs live in `node.params`, so the cache key
 *    derived by `@picasso/canvas-core` changes when the book does, without this
 *    module knowing anything about hashing.
 *  - **A loose StrategyNode is a drawing.** An analyst sketching a risk reversal
 *    before deciding it is real gets no evaluation, no cost and no spinner
 *    (PRD 3.2). Evaluation refuses rather than quietly promoting.
 */

import {
  createNode,
  type NodeID,
  type ParamValue,
  type PicassoNode,
  type Port,
  type Vec2,
} from '@picasso/canvas-core';
import type { GridPricer, GridResult, GridSpec, Leg, Market } from './grid.js';

/** PRD's worked example: 25 spots by 15 vols. */
export const DEFAULT_GRID: GridSpec = {
  spotSteps: 25,
  spotRange: 0.2,
  volSteps: 15,
  volRange: 0.1,
};

/** The node's typed ports. A surface out, so a SurfaceNode can render it. */
export function strategyPorts(): { inputs: Port[]; outputs: Port[] } {
  return {
    inputs: [
      { id: 'underlier', name: 'Underlier', type: 'instrument', cardinality: 'one', required: true },
      { id: 'vol', name: 'Vol surface', type: 'surface', cardinality: 'one', required: false },
    ],
    outputs: [
      {
        id: 'pnl',
        name: 'P&L surface',
        type: 'surface',
        cardinality: 'one',
        required: false,
      },
      { id: 'book', name: 'Book', type: 'portfolio', cardinality: 'one', required: false },
    ],
  };
}

export interface StrategyNodeInput {
  id: NodeID;
  legs: readonly Leg[];
  market: Market;
  grid?: GridSpec;
  position?: Vec2;
  /** Defaults to `wired`: a book someone typed out is usually meant to compute. */
  binding?: PicassoNode['binding'];
}

/**
 * The legs and the market, flattened into params.
 *
 * `ParamValue` is deliberately narrow — the cache key hashes params, so
 * anything that is not plain data cannot go in one. Flattening here rather than
 * widening the type keeps that property.
 */
function toParams(input: StrategyNodeInput): Record<string, ParamValue> {
  const grid = input.grid ?? DEFAULT_GRID;
  return {
    legs: input.legs.map((leg) => ({
      strike: leg.strike,
      time: leg.time,
      kind: leg.kind,
      style: leg.style,
      quantity: leg.quantity,
      multiplier: leg.multiplier,
      vol: leg.vol,
    })),
    market: { spot: input.market.spot, rate: input.market.rate, dividend: input.market.dividend },
    grid: {
      spotSteps: grid.spotSteps,
      spotRange: grid.spotRange,
      volSteps: grid.volSteps,
      volRange: grid.volRange,
      decayDays: grid.decayDays ?? 0,
    },
  };
}

export function createStrategyNode(input: StrategyNodeInput): PicassoNode {
  const ports = strategyPorts();
  return createNode({
    id: input.id,
    kind: 'StrategyNode',
    binding: input.binding ?? 'wired',
    position: input.position ?? { x: 0, y: 0 },
    size: { w: 420, h: 300 },
    inputs: ports.inputs,
    outputs: ports.outputs,
    params: toParams(input),
    // The chain is licensed data wherever the marks come from.
    entitlementTags: ['opra'],
    nodeVersion: '1',
  });
}

/** Reads the book back out of params, for evaluation or for the AI context. */
export function readBook(node: PicassoNode): { legs: Leg[]; market: Market; grid: GridSpec } {
  const params = node.params as unknown as {
    legs: Leg[];
    market: Market;
    grid: GridSpec;
  };
  return { legs: params.legs, market: params.market, grid: params.grid };
}

export interface EvaluationOk {
  ok: true;
  result: GridResult;
  node: PicassoNode;
}

export interface EvaluationRefused {
  ok: false;
  reason: 'loose' | 'empty_book';
  message: string;
}

export type Evaluation = EvaluationOk | EvaluationRefused;

/**
 * Computes the node, and writes the outcome into its runtime state.
 *
 * The mutation is the point: the node's status, latency and badge are what the
 * renderer reads, and a compute path that returns a value without updating them
 * leaves a node that says "computing" forever.
 */
export function evaluateStrategy(
  node: PicassoNode,
  pricer: GridPricer,
  now: () => number = () => Date.now(),
): Evaluation {
  if (node.binding === 'loose') {
    // Not an error. A sketch is allowed to be a sketch, and the caller should
    // never have scheduled it — `schedule()` skips loose nodes, so reaching
    // here means something bypassed the scheduler.
    return {
      ok: false,
      reason: 'loose',
      message: 'This strategy is a sketch. Promote it to compute a P&L surface.',
    };
  }

  const { legs, market, grid } = readBook(node);
  if (legs.length === 0) {
    node.state = {
      status: 'error',
      error: { code: 'empty_book', message: 'Add a leg to price this strategy.', retriable: false },
    };
    return { ok: false, reason: 'empty_book', message: 'Add a leg to price this strategy.' };
  }

  node.state = { ...node.state, status: 'computing' };
  const result = pricer.reprice(legs, market, grid);

  node.state = {
    status: 'ready',
    lastComputedAt: now(),
    latencyMs: result.elapsedMs,
    ...(node.state.cacheKey !== undefined ? { cacheKey: node.state.cacheKey } : {}),
  };
  return { ok: true, result, node };
}

/**
 * What the node shows under its title: the guard's own words.
 *
 * The badge comes out of Rust rather than being composed here, because the
 * server renders the same sentence and two implementations of one sentence
 * drift.
 */
export function guardBadge(result: GridResult): string {
  return result.guard.badge;
}

/** The aggregate row a StrategyNode shows at the unshocked centre of the grid. */
export function atTheMoney(result: GridResult): GridResult['cells'][number] {
  const spotIndex = (result.spotCount - 1) >> 1;
  const volIndex = (result.volCount - 1) >> 1;
  return result.cell(spotIndex, volIndex);
}
