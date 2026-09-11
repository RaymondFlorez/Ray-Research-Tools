/**
 * Port type system and connect-time validation.
 *
 * PRD 3.4.5: "Wiring a `series` into a `scalar` port is legal and inserts an
 * implicit `latest()` adapter, shown on the edge as a small badge. Wiring
 * `series(daily)` into a port constrained to `series(intraday)` fails
 * validation at connect time with an inline explanation and a one-click
 * 'insert resample node' fix."
 *
 * Every rejection carries a machine-readable code, a sentence the UI can show
 * inline, and, where one exists, the fix the analyst can apply in one click.
 */

import type {
  AdapterKind,
  Edge,
  Frequency,
  PicassoNode,
  Port,
  PortMetadata,
  PortType,
} from './types.js';
import { isComputeKind } from './nodeKinds.js';

export type ConnectionErrorCode =
  | 'self_loop'
  | 'not_wired'
  | 'unknown_port'
  | 'type_mismatch'
  | 'frequency_mismatch'
  | 'currency_mismatch'
  | 'asset_class_mismatch'
  | 'insufficient_history'
  | 'port_occupied'
  | 'duplicate_edge'
  | 'cycle'
  | 'unverified_input';

/** A one-click remedy offered alongside a rejection. */
export type ConnectionFix =
  | { kind: 'insert_node'; nodeKind: 'TransformNode'; op: 'resample'; to: Frequency; label: string }
  | { kind: 'insert_node'; nodeKind: 'TransformNode'; op: 'convert_currency'; to: string; label: string }
  | { kind: 'promote'; nodeId: string; to: 'wired'; label: string }
  | { kind: 'override_unverified'; nodeId: string; label: string };

export interface ConnectionOk {
  ok: true;
  /** Implicit coercion to stamp on the edge, rendered as a badge. */
  adapter?: AdapterKind;
  /** Non-blocking notes to surface on hover. */
  warnings: string[];
}

export interface ConnectionRejected {
  ok: false;
  code: ConnectionErrorCode;
  /** Inline explanation, written to be shown verbatim next to the cursor. */
  message: string;
  fix?: ConnectionFix;
}

export type ConnectionResult = ConnectionOk | ConnectionRejected;

/** Coarse-to-fine ordering used to describe a resample as up or down. */
const FREQUENCY_ORDER: readonly Frequency[] = [
  'tick',
  'intraday',
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'annual',
];

export function frequencyRank(f: Frequency): number {
  return FREQUENCY_ORDER.indexOf(f);
}

/**
 * Implicit coercions. Anything not listed here is a type error the analyst has
 * to resolve deliberately, because a silent conversion is a silent assumption.
 */
const IMPLICIT_ADAPTERS: ReadonlyArray<{ from: PortType; to: PortType; adapter: AdapterKind }> = [
  { from: 'series', to: 'scalar', adapter: 'latest' },
];

export function implicitAdapter(from: PortType, to: PortType): AdapterKind | undefined {
  if (from === to) return undefined;
  return IMPLICIT_ADAPTERS.find((rule) => rule.from === from && rule.to === to)?.adapter;
}

export function typesConnect(from: PortType, to: PortType): boolean {
  return from === to || implicitAdapter(from, to) !== undefined;
}

export function findPort(ports: readonly Port[], portId: string): Port | undefined {
  return ports.find((p) => p.id === portId);
}

export interface ValidateOptions {
  /** Edges already on the canvas, used for cardinality and duplicate checks. */
  edges?: readonly Edge[];
  /** Returns true when a data edge source -> target would close a cycle. */
  wouldCreateCycle?: (fromNodeId: string, toNodeId: string) => boolean;
  /** Set when the analyst has already approved an unverified input here. */
  hasUnverifiedOverride?: boolean;
}

/**
 * Validates a prospective `data` edge. Returns either the adapter to stamp on
 * the edge, or the reason the wire is refused plus the fix to offer.
 */
export function validateConnection(
  source: PicassoNode,
  sourcePortId: string,
  target: PicassoNode,
  targetPortId: string,
  options: ValidateOptions = {},
): ConnectionResult {
  const { edges = [], wouldCreateCycle, hasUnverifiedOverride = false } = options;

  if (source.id === target.id) {
    return { ok: false, code: 'self_loop', message: 'A node cannot wire into itself.' };
  }

  // PRD 3.2: only `wired` objects expose ports. Loose and bound objects are
  // reachable by pointer but carry nothing to connect.
  for (const node of [source, target] as const) {
    if (node.binding !== 'wired') {
      return {
        ok: false,
        code: 'not_wired',
        message: `${node.kind} is ${node.binding} and has no ports. Promote it to wire it.`,
        fix: { kind: 'promote', nodeId: node.id, to: 'wired', label: 'Promote to wired' },
      };
    }
  }

  const out = findPort(source.outputs, sourcePortId);
  const inp = findPort(target.inputs, targetPortId);
  if (!out) {
    return { ok: false, code: 'unknown_port', message: `No output port "${sourcePortId}" on ${source.kind}.` };
  }
  if (!inp) {
    return { ok: false, code: 'unknown_port', message: `No input port "${targetPortId}" on ${target.kind}.` };
  }

  const duplicate = edges.some(
    (e) =>
      e.class === 'data' &&
      e.from.nodeId === source.id &&
      e.from.portId === sourcePortId &&
      e.to.nodeId === target.id &&
      e.to.portId === targetPortId,
  );
  if (duplicate) {
    return { ok: false, code: 'duplicate_edge', message: 'These ports are already wired together.' };
  }

  if (inp.cardinality === 'one') {
    const occupied = edges.some(
      (e) => e.class === 'data' && e.to.nodeId === target.id && e.to.portId === targetPortId,
    );
    if (occupied) {
      return {
        ok: false,
        code: 'port_occupied',
        message: `${inp.name} accepts one input and already has one. Disconnect it first.`,
      };
    }
  }

  if (!typesConnect(out.type, inp.type)) {
    return {
      ok: false,
      code: 'type_mismatch',
      message: `${out.type} does not fit a ${inp.type} port.`,
    };
  }

  const adapter = implicitAdapter(out.type, inp.type);
  const constraintResult = checkConstraints(out, inp);
  if (constraintResult) return constraintResult;

  if (wouldCreateCycle?.(source.id, target.id)) {
    return {
      ok: false,
      code: 'cycle',
      message: 'This wire would close a cycle. Only causal edges may cycle.',
    };
  }

  // PRD 4.5: model-provenance values are unverified and cannot feed a compute
  // node without an explicit, logged override.
  if (!source.provenance.verified && isComputeKind(target.kind) && !hasUnverifiedOverride) {
    return {
      ok: false,
      code: 'unverified_input',
      message: `${source.kind} output is unverified (model-generated). It cannot feed ${target.kind} without an override.`,
      fix: { kind: 'override_unverified', nodeId: source.id, label: 'Override and log' },
    };
  }

  const warnings: string[] = [];
  if (adapter === 'latest') {
    warnings.push('Implicit latest(): only the most recent observation is passed through.');
  }

  return adapter === undefined ? { ok: true, warnings } : { ok: true, adapter, warnings };
}

/**
 * Constraint checks (frequency, currency, asset class, minimum history) run
 * after the type check, because a frequency error is a different conversation
 * from a type error and gets a different fix.
 */
function checkConstraints(out: Port, inp: Port): ConnectionRejected | undefined {
  const c = inp.constraints;
  if (!c) return undefined;
  const meta: PortMetadata = out.emits ?? {};

  if (c.frequency && c.frequency.length > 0 && meta.frequency) {
    if (!c.frequency.includes(meta.frequency)) {
      const wanted = c.frequency[0] as Frequency;
      const direction = frequencyRank(meta.frequency) > frequencyRank(wanted) ? 'Upsample' : 'Downsample';
      return {
        ok: false,
        code: 'frequency_mismatch',
        message: `series(${meta.frequency}) into a port constrained to series(${c.frequency.join('|')}).`,
        fix: {
          kind: 'insert_node',
          nodeKind: 'TransformNode',
          op: 'resample',
          to: wanted,
          label: `${direction} to ${wanted}`,
        },
      };
    }
  }

  if (c.currency && meta.currency && c.currency !== meta.currency) {
    return {
      ok: false,
      code: 'currency_mismatch',
      message: `Input is ${meta.currency}; this port requires ${c.currency}.`,
      fix: {
        kind: 'insert_node',
        nodeKind: 'TransformNode',
        op: 'convert_currency',
        to: c.currency,
        label: `Convert to ${c.currency}`,
      },
    };
  }

  if (c.assetClass && c.assetClass.length > 0 && meta.assetClass) {
    if (!c.assetClass.includes(meta.assetClass)) {
      return {
        ok: false,
        code: 'asset_class_mismatch',
        message: `${meta.assetClass} is not accepted here (expects ${c.assetClass.join(', ')}).`,
      };
    }
  }

  if (c.minHistory !== undefined && meta.history !== undefined && meta.history < c.minHistory) {
    return {
      ok: false,
      code: 'insufficient_history',
      message: `Needs at least ${c.minHistory} observations; upstream has ${meta.history}.`,
    };
  }

  return undefined;
}

/**
 * PRD 3.8: "incompatible ports dim" while a wire is being dragged. This is the
 * query the renderer runs per candidate port on drag start.
 */
export function compatibleInputPorts(
  source: PicassoNode,
  sourcePortId: string,
  target: PicassoNode,
  options: ValidateOptions = {},
): Port[] {
  return target.inputs.filter(
    (p) => validateConnection(source, sourcePortId, target, p.id, options).ok,
  );
}
