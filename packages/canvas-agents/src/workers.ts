/**
 * Agents that do the work, for `run` to schedule (PRD 4.5, 5.7).
 *
 * The runtime takes an `AgentFn` per step and has, until now, only ever been
 * handed functions a test wrote. These are the first that reach real systems:
 * a retriever that reads facts through a `PointInTimeSource` — the Go data
 * plane over HTTP, or the in-process store — and two pricers that compute
 * through the Rust core's WASM build, one bootstrapping a curve and repricing a
 * bond sleeve under a shock, one repricing an options book across a grid.
 *
 * They talk to each other only through the board, the way the PRD's agents do.
 * The retriever asserts each value it read as a fact with `cell` provenance —
 * the tile it materializes, keyed on what was read and as of when — and a
 * pricer finds its inputs among the facts its own dependencies asserted, by
 * key. Three refusals follow from that:
 *
 *   - **A value the reader may not see is not a value.** A withheld or empty
 *     key fails the retrieval step, so everything downstream is skipped rather
 *     than priced on part of its inputs. What was read is still on the board.
 *   - **A pricer reads only what its dependencies retrieved.** A fact some
 *     unrelated step put on the board is not an input it declared, and the
 *     step fails naming the key it could not find.
 *   - **A contested input is not an input.** Two steps that read the same key
 *     and got different numbers is a conflict for the Reconciler, and pricing
 *     off either would choose a winner without saying so.
 *
 * The one piece of arithmetic here is the bond sleeve's sum of discounted cash
 * flows; every discount factor, every option price and every Greek comes out of
 * the WASM module, which is the same compiled code the server runs.
 */

import { canonicalize, hash } from '@picasso/canvas-core';
import { latestKnown, type PointInTimeSource, type SourceRead } from '@picasso/canvas-data';
import type {
  AnyCurveShock,
  CashFlow,
  CurveEngine,
  GridPricer,
  GridSpec,
  Instrument,
  Leg,
  Market,
} from '@picasso/canvas-pricing';
import type { Blackboard, Fact, PlanStep } from './blackboard.js';
import type { AgentFn, AgentOutcome } from './coordinator.js';
import { sameUnit } from './numeric.js';
import type { CellReading } from './reconciler.js';

/** What the retriever read for one key, as the board holds it. */
export const factId = (stepId: string, key: string): string => `${stepId}:${key}`;

export interface RetrievalOptions {
  source: PointInTimeSource;
  /** The keys to read, each with the unit its values are in. */
  keys: ReadonlyArray<{ key: string; unit: string }>;
  /** Every read names its knowledge time: the canvas's pin, or now. */
  knowledgeTime: string;
}

/**
 * Reads each key's latest period known at `knowledgeTime` and asserts it.
 *
 * One round trip where the source batches (`readMany`; the data plane's
 * `/v1/asof/batch`), one read a key otherwise.
 */
export function retrievalAgent(options: RetrievalOptions): AgentFn {
  return async ({ board, step }): Promise<AgentOutcome> => {
    const keys = options.keys.map((k) => k.key);
    const reads: ReadonlyMap<string, SourceRead> = options.source.readMany
      ? await options.source.readMany(keys, options.knowledgeTime)
      : new Map(
          await Promise.all(
            keys.map(async (key) => [key, await options.source.read({ key, knowledgeTime: options.knowledgeTime })] as const),
          ),
        );
    const missing: string[] = [];
    const artifacts: AgentOutcome['artifacts'] = [];
    for (const { key, unit } of options.keys) {
      const read = reads.get(key);
      const latest = read ? latestKnown(read) : ({ kind: 'empty' } as const);
      if (latest.kind === 'blocked') {
        missing.push(`${key} is withheld (${latest.message})`);
        continue;
      }
      if (latest.kind === 'empty') {
        missing.push(`${key} has no value known at ${options.knowledgeTime}`);
        continue;
      }
      const o = latest.observation;
      const nodeId = `${step.id}/${key}`;
      board.assert({
        id: factId(step.id, key),
        claim: `${key}, latest known at ${options.knowledgeTime}`,
        value: { number: o.value, unit, asof: o.validTime },
        provenance: {
          kind: 'cell',
          nodeId,
          cacheKey: hash(canonicalize({ source: options.source.name, key, knowledgeTime: options.knowledgeTime, validTime: o.validTime, knownAt: o.knownAt, value: o.value })),
        },
        confidence: 1,
        assertedBy: step.agent,
      });
      artifacts.push({ nodeId, kind: 'DataTile' });
    }
    if (missing.length > 0) {
      throw new Error(`read ${artifacts.length} of ${keys.length} from ${options.source.name}; ${missing.join('; ')}`);
    }
    return { artifacts, note: `read ${keys.length} key(s) from ${options.source.name} as of ${options.knowledgeTime}` };
  };
}

/**
 * An input the step declared, from the facts its dependencies asserted.
 *
 * Throws, which fails the step, when no dependency read the key, or when the
 * fact is contested or retracted.
 */
export function inputFact(board: Blackboard, step: PlanStep, key: string): Fact {
  const found = step.dependsOn.map((dep) => board.fact(factId(dep, key))).filter((f): f is Fact => f !== undefined);
  if (found.length === 0) {
    throw new Error(`needs ${key}, which none of ${step.dependsOn.join(', ') || 'its (no) dependencies'} retrieved`);
  }
  const live = found.filter((f) => !f.retracted);
  if (live.length === 0) throw new Error(`${key} was retracted`);
  const fact = live[0] as Fact;
  if (live.some((f) => f.contested)) throw new Error(`${key} is contested on the board; the Reconciler decides it first`);
  if (!fact.value) throw new Error(`${key} has no value`);
  return fact;
}

export interface CurvePoint {
  /** The fact key the par yield was read under, e.g. `UST.par.2Y`. */
  key: string;
  /** Its maturity in years. */
  years: number;
}

export interface Bond {
  id: string;
  /** `[years, amount]` per unit held. */
  flows: readonly CashFlow[];
  quantity: number;
}

export interface CurveShockOptions {
  curves: CurveEngine;
  points: readonly CurvePoint[];
  book: readonly Bond[];
  shock: AnyCurveShock;
  /**
   * The canvas's cell readings, which the join reconciles a narrative
   * against. Each output the node computes is written here as it computes it.
   */
  cells?: CellReading[];
}

/**
 * Par yields in percent to instruments the engine bootstraps.
 *
 * Maturities of a year or less go in as deposits, longer ones as par swaps
 * paying twice a year. That is a convention, not the Treasury's: a bill's
 * quoted yield is a bond-equivalent yield on a discount instrument and a note
 * pays its coupon on its own dates, so the curve this builds reprices these
 * inputs exactly (its residuals say so) without being the curve a Treasury
 * desk would quote.
 */
export function parInstruments(yields: ReadonlyArray<{ years: number; pct: number }>): Instrument[] {
  return [...yields]
    .sort((a, b) => a.years - b.years)
    .map(({ years, pct }) =>
      years <= 1 ? { kind: 'deposit', maturity: years, rate: pct / 100 } : { kind: 'swap', maturity: years, rate: pct / 100, frequency: 2 },
    );
}

/**
 * Bootstraps the curve from the par yields its dependencies read, and
 * reprices the bond sleeve on it and under the shock.
 *
 * Asserts the sleeve's value at both and the difference, with the difference's
 * `derivation` naming the other two, so the Reconciler can check a narrated
 * P&L against its parts and not only against the node.
 */
export function curveShockAgent(options: CurveShockOptions): AgentFn {
  return ({ board, step }): AgentOutcome => {
    if (options.book.length === 0) throw new Error('an empty sleeve has nothing to reprice');
    const inputs = options.points.map((p) => {
      const fact = inputFact(board, step, p.key);
      const value = fact.value as NonNullable<Fact['value']>;
      if (!sameUnit(value.unit, 'pct')) throw new Error(`${p.key} is in ${value.unit}; a par yield is read in pct`);
      return { point: p, fact, pct: value.number };
    });
    const instruments = parInstruments(inputs.map((i) => ({ years: i.point.years, pct: i.pct })));
    const base = options.curves.bootstrap(instruments);
    const residualBps = base.worstResidualBps();
    const value = (curve: typeof base): number =>
      options.book.reduce((total, bond) => total + bond.quantity * bond.flows.reduce((v, [t, cf]) => v + cf * curve.discount(t), 0), 0);
    const baseValue = value(base);
    const shockedValue = value(options.curves.shocked(instruments, options.shock));

    const nodeId = `${step.id}/sleeve`;
    const asof = inputs.map((i) => (i.fact.value as NonNullable<Fact['value']>).asof).sort().at(-1) as string;
    const cacheKey = hash(canonicalize({ instruments, shock: options.shock, book: options.book, inputs: inputs.map((i) => i.fact.provenance) }));
    const assert = (port: string, claim: string, number: number, derivation?: Fact['derivation'], unit = 'usd'): Fact => {
      options.cells?.push({ nodeId, cacheKey, port, label: claim, value: number, unit, asof });
      return board.assert({
        id: `${step.id}:${port}`,
        claim,
        value: { number, unit, asof },
        provenance: { kind: 'cell', nodeId, cacheKey, port },
        confidence: 1,
        assertedBy: step.agent,
        ...(derivation ? { derivation } : {}),
      });
    };
    const shockName = options.shock.shape === 'custom' ? 'the drawn shock' : `a ${options.shock.bps}bp ${options.shock.shape} shock`;
    // The size of the move is an input the answer will state, so it is a fact too.
    if (options.shock.shape !== 'custom') assert('shock', `the ${options.shock.shape} shock applied`, options.shock.bps, undefined, 'bps');
    const before = assert('base', 'bond sleeve value on the curve', baseValue);
    const after = assert('shocked', `bond sleeve value under ${shockName}`, shockedValue);
    assert('pnl', `bond sleeve P&L under ${shockName}`, shockedValue - baseValue, { op: 'difference', operands: [after.id, before.id] });
    return {
      artifacts: [{ nodeId: `${step.id}/curve`, kind: 'CurveNode' }, { nodeId, kind: 'ScenarioNode' }],
      note: `bootstrapped ${instruments.length} par yields (worst residual ${residualBps.toExponential(1)}bp) and repriced ${options.book.length} bond(s)`,
    };
  };
}

export interface BookGridOptions {
  pricer: GridPricer;
  book: readonly Leg[];
  /** Which fact keys carry the market, and how to read each into the engine's units. */
  market: {
    spot: string;
    /** A rate in pct, divided by 100 for the engine. */
    rate: string;
    /** A continuous yield in pct; zero when absent. */
    dividend?: string;
  };
  /** Odd step counts put today's market on the centre cell. */
  grid: GridSpec;
  /** The canvas's cell readings; see `CurveShockOptions.cells`. */
  cells?: CellReading[];
}

/**
 * Reprices an options book across a spot-vol grid at the market its
 * dependencies retrieved, and asserts the book at today's market: value,
 * delta and vega, from the centre cell, with the guard's verdict in the note.
 */
export function bookGridAgent(options: BookGridOptions): AgentFn {
  return ({ board, step }): AgentOutcome => {
    if (options.grid.spotSteps % 2 === 0 || options.grid.volSteps % 2 === 0) {
      throw new Error('the grid needs odd step counts so that one cell is today’s market');
    }
    const read = (key: string, unit: string): Fact => {
      const fact = inputFact(board, step, key);
      if (!sameUnit((fact.value as NonNullable<Fact['value']>).unit, unit)) {
        throw new Error(`${key} is in ${fact.value?.unit}; this input is read in ${unit}`);
      }
      return fact;
    };
    const spot = read(options.market.spot, 'usd');
    const rate = read(options.market.rate, 'pct');
    const dividend = options.market.dividend !== undefined ? read(options.market.dividend, 'pct') : undefined;
    const market: Market = {
      spot: (spot.value as NonNullable<Fact['value']>).number,
      rate: (rate.value as NonNullable<Fact['value']>).number / 100,
      dividend: dividend ? (dividend.value as NonNullable<Fact['value']>).number / 100 : 0,
    };
    const result = options.pricer.reprice(options.book, market, options.grid);
    const centre = result.cell((options.grid.spotSteps - 1) / 2, (options.grid.volSteps - 1) / 2);
    const inputs = [spot, rate, ...(dividend ? [dividend] : [])];
    const asof = inputs.map((f) => (f.value as NonNullable<Fact['value']>).asof).sort().at(-1) as string;
    const nodeId = `${step.id}/strategy`;
    const cacheKey = hash(canonicalize({ book: options.book, market, grid: options.grid, inputs: inputs.map((f) => f.provenance) }));
    for (const [port, number, unit] of [
      ['value', centre.value, 'usd'],
      ['delta', centre.delta, 'shares'],
      ['vega', centre.vega, 'usd per vol'],
    ] as const) {
      options.cells?.push({ nodeId, cacheKey, port, label: `options book ${port}`, value: number, unit, asof });
      board.assert({
        id: `${step.id}:${port}`,
        claim: `options book ${port} at today's market`,
        value: { number, unit, asof },
        provenance: { kind: 'cell', nodeId, cacheKey, port },
        confidence: 1,
        assertedBy: step.agent,
      });
    }
    return {
      artifacts: [{ nodeId, kind: 'StrategyNode' }],
      note: `${result.guard.repricings} repricings at ${result.quality}, ${result.guard.badge}, in ${result.elapsedMs.toFixed(1)}ms`,
    };
  };
}
