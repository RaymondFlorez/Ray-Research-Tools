/**
 * `CurveNode` and `RateShockNode` on the canvas (PRD 3.3, 5.3).
 *
 * The same shape as `StrategyNode`: the inputs live in `node.params` so
 * `@picasso/canvas-core` derives a cache key from them without this module
 * knowing anything about hashing, and a `loose` node is a drawing rather than a
 * computation.
 *
 * What is new here is the edge between them. A `RateShockNode` emits a `curve`,
 * and PRD 5.3 says "any equity, credit, or options node can consume" it,
 * "applying its own sensitivity model". So the shock does not know what it is
 * shocking — it emits a shape, and the consumer decides what that shape means
 * for its own asset. That is why `transmit` lives on the options side and not
 * here.
 */

import {
  createNode,
  type NodeID,
  type ParamValue,
  type PicassoNode,
  type Port,
  type Vec2,
} from '@picasso/canvas-core';
import {
  STANDARD_TENORS,
  type Curve,
  type CurveEngine,
  type CurveShock,
  type Instrument,
  type NssFit,
} from './curve.js';

/** A `CurveNode` builds its curve one of two ways, and they differ in kind. */
export type CurveMethod =
  /** Reproduces its instruments exactly. */
  | { kind: 'bootstrap'; instruments: readonly Instrument[] }
  /** Approximates observed yields with six parameters, and reports the miss. */
  | { kind: 'nss'; observations: ReadonlyArray<{ tenor: number; rate: number }> };

export function curvePorts(): { inputs: Port[]; outputs: Port[] } {
  return {
    inputs: [
      { id: 'quotes', name: 'Quotes', type: 'table', cardinality: 'one', required: false },
    ],
    outputs: [
      { id: 'curve', name: 'Curve', type: 'curve', cardinality: 'one', required: false },
      // PRD 5.3: "Fitting parameters and residuals both output as ports."
      { id: 'params', name: 'Parameters', type: 'table', cardinality: 'one', required: false },
      { id: 'residuals', name: 'Residuals', type: 'series', cardinality: 'one', required: false },
    ],
  };
}

export function rateShockPorts(): { inputs: Port[]; outputs: Port[] } {
  return {
    inputs: [
      { id: 'curve', name: 'Base curve', type: 'curve', cardinality: 'one', required: true },
    ],
    outputs: [
      { id: 'shocked', name: 'Shocked curve', type: 'curve', cardinality: 'one', required: false },
    ],
  };
}

export interface CurveNodeInput {
  id: NodeID;
  method: CurveMethod;
  position?: Vec2;
  binding?: PicassoNode['binding'];
}

/** The method, flattened into params so the cache key follows it. */
function curveParams(method: CurveMethod): Record<string, ParamValue> {
  if (method.kind === 'bootstrap') {
    return {
      method: 'bootstrap',
      instruments: method.instruments.map((i) =>
        i.kind === 'deposit'
          ? { kind: i.kind, maturity: i.maturity, rate: i.rate }
          : i.kind === 'future'
            ? {
                kind: i.kind,
                start: i.start,
                end: i.end,
                rate: i.rate,
                convexityBps: i.convexityBps ?? 0,
              }
            : { kind: i.kind, maturity: i.maturity, rate: i.rate, frequency: i.frequency ?? 2 },
      ),
    };
  }
  return {
    method: 'nss',
    observations: method.observations.map((o) => ({ tenor: o.tenor, rate: o.rate })),
  };
}

export function createCurveNode(input: CurveNodeInput): PicassoNode {
  const ports = curvePorts();
  return createNode({
    id: input.id,
    kind: 'CurveNode',
    binding: input.binding ?? 'wired',
    position: input.position ?? { x: 0, y: 0 },
    size: { w: 380, h: 260 },
    inputs: ports.inputs,
    outputs: ports.outputs,
    params: curveParams(input.method),
    entitlementTags: ['rates'],
    nodeVersion: '1',
  });
}

export interface RateShockNodeInput {
  id: NodeID;
  shock: CurveShock;
  position?: Vec2;
  binding?: PicassoNode['binding'];
}

export function createRateShockNode(input: RateShockNodeInput): PicassoNode {
  const ports = rateShockPorts();
  return createNode({
    id: input.id,
    kind: 'ScenarioNode',
    binding: input.binding ?? 'wired',
    position: input.position ?? { x: 0, y: 0 },
    size: { w: 300, h: 180 },
    inputs: ports.inputs,
    outputs: ports.outputs,
    params: {
      shape: input.shock.shape,
      bps: input.shock.bps,
      pivot: input.shock.pivot ?? 0,
    },
    nodeVersion: '1',
  });
}

export function readCurveMethod(node: PicassoNode): CurveMethod {
  const params = node.params as unknown as {
    method: 'bootstrap' | 'nss';
    instruments?: Instrument[];
    observations?: Array<{ tenor: number; rate: number }>;
  };
  return params.method === 'bootstrap'
    ? { kind: 'bootstrap', instruments: params.instruments ?? [] }
    : { kind: 'nss', observations: params.observations ?? [] };
}

export function readShock(node: PicassoNode): CurveShock {
  const params = node.params as unknown as CurveShock & { pivot: number };
  return { shape: params.shape, bps: params.bps, pivot: params.pivot };
}

export interface CurveEvaluationOk {
  ok: true;
  curve: Curve;
  /** Present for a fit; a bootstrap has no parameters to report. */
  fit?: NssFit;
  /** Zero rates at the standard buckets, which is what a chart draws. */
  rates: Array<{ tenor: number; rate: number }>;
  /**
   * What the node shows under its title.
   *
   * A bootstrap says how exactly it reproduces its inputs; a fit says how far
   * it misses. Those are different claims and the badge does not blur them.
   */
  badge: string;
}

export interface CurveEvaluationRefused {
  ok: false;
  reason: 'loose' | 'no_quotes' | 'will_not_build';
  message: string;
}

export type CurveEvaluation = CurveEvaluationOk | CurveEvaluationRefused;

/**
 * Computes a `CurveNode`, writing the outcome into its runtime state.
 *
 * The badge is the interesting part. A bootstrap that reproduces its quotes to
 * machine precision and a six-parameter fit that misses by four basis points
 * are both "a curve", and an analyst who cannot tell them apart at a glance
 * will eventually trade on the wrong one.
 */
export function evaluateCurve(
  node: PicassoNode,
  engine: CurveEngine,
  now: () => number = () => Date.now(),
): CurveEvaluation {
  if (node.binding === 'loose') {
    return {
      ok: false,
      reason: 'loose',
      message: 'This curve is a sketch. Promote it to build it from quotes.',
    };
  }

  const method = readCurveMethod(node);
  const started = now();

  try {
    if (method.kind === 'bootstrap') {
      if (method.instruments.length === 0) {
        return refuse(node, 'no_quotes', 'Add a deposit, future or swap to build this curve.');
      }
      const curve = engine.bootstrap(method.instruments);
      const worst = curve.worstResidualBps();
      node.state = { status: 'ready', lastComputedAt: now(), latencyMs: now() - started };
      return {
        ok: true,
        curve,
        rates: curve.tenorRates(),
        badge:
          worst < 1e-6
            ? `bootstrapped, reprices all ${method.instruments.length} quotes`
            : `bootstrapped, worst quote off by ${worst.toFixed(2)}bp`,
      };
    }

    if (method.observations.length < 4) {
      return refuse(
        node,
        'no_quotes',
        'Nelson-Siegel-Svensson has six parameters; fit it to at least four points.',
      );
    }
    const fit = engine.fitNss(method.observations);
    if (!fit) {
      return refuse(node, 'will_not_build', 'These observations do not admit a fit.');
    }
    const curve = engine.curveFromFit();
    node.state = {
      status: fit.warning !== undefined ? 'unverified' : 'ready',
      lastComputedAt: now(),
      latencyMs: now() - started,
    };
    return {
      ok: true,
      curve,
      fit,
      rates: STANDARD_TENORS.map((tenor) => ({ tenor, rate: fit.zero(tenor) })),
      // A fit that misses is still a curve; it is just not the market, and the
      // badge is where that distinction has to survive.
      badge:
        fit.warning !== undefined
          ? `fitted, misses ${fit.maxAbsBps.toFixed(1)}bp at ${fit.worstTenor}y`
          : `fitted, within ${fit.maxAbsBps.toFixed(1)}bp everywhere`,
    };
  } catch (error) {
    return refuse(node, 'will_not_build', error instanceof Error ? error.message : String(error));
  }
}

function refuse(
  node: PicassoNode,
  reason: 'no_quotes' | 'will_not_build',
  message: string,
): CurveEvaluationRefused {
  node.state = { status: 'error', error: { code: reason, message, retriable: false } };
  return { ok: false, reason, message };
}
