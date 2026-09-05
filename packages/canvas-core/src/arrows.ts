/**
 * Drawn-arrow resolution (PRD 3.2.2).
 *
 * "A drawn arrow is an `annotation` edge until proven otherwise, and it is
 * never silently converted." This module is the whole of that rule: it decides
 * what class a freshly drawn arrow lands as, and, where a real data edge is
 * available, hands back the promote affordance the analyst may click. It never
 * returns a `data` edge on its own.
 */

import type { AdapterKind, Edge, EdgeClass, PicassoNode } from './types.js';
import type { ConnectionFix, ValidateOptions } from './ports.js';
import { validateConnection } from './ports.js';

export interface ArrowPromotion {
  /** The port pair a single click would wire. */
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
  /** Implicit coercion the badge would show. */
  adapter?: AdapterKind;
}

export interface DrawnArrowResolution {
  class: EdgeClass;
  /** Present when one click would turn this drawing into a real data edge. */
  promotable?: ArrowPromotion;
  /** Inline reason shown on hover when a data edge was plausible but refused. */
  reason?: string;
  /** One-click remedy that accompanies `reason`. */
  fix?: ConnectionFix;
  /**
   * Set when the arrow attaches a loose object to a node as context. The note
   * travels with the node and enters the AI context builder under this tag,
   * as intent and hypothesis, never as data (PRD 3.2.5).
   */
  contextTag?: 'analyst_note';
  /** Causal edges prompt for sign, elasticity and lag inline before they bind. */
  needsCausalParams?: boolean;
}

export interface ResolveArrowOptions extends ValidateOptions {
  /** True while the Causal tool (`C`) is held; every arrow drawn is causal. */
  causalMode?: boolean;
  /** Restrict the search to this port pair when the analyst drew port-to-port. */
  hint?: { fromPortId?: string; toPortId?: string };
}

/**
 * Resolves a freshly drawn arrow between two objects.
 *
 * Endpoint table (PRD 3.2.2), with the two unlisted combinations resolved the
 * conservative way: an arrow *out of* a node into a loose object is a drawing,
 * and a `bound` endpoint behaves like a loose one because it exposes no ports.
 */
export function resolveDrawnArrow(
  source: PicassoNode,
  target: PicassoNode,
  options: ResolveArrowOptions = {},
): DrawnArrowResolution {
  // Row 4 wins over every other row: the tool the analyst chose states intent.
  if (options.causalMode) {
    return { class: 'causal', needsCausalParams: true };
  }

  const sourceWired = source.binding === 'wired';
  const targetWired = target.binding === 'wired';

  // Row 5: loose -> wired attaches the note to the node as context.
  if (!sourceWired && targetWired) {
    return { class: 'reference', contextTag: 'analyst_note' };
  }

  // Rows 1 and the wired -> loose case: a drawing is a drawing.
  if (!sourceWired || !targetWired) {
    return { class: 'annotation' };
  }

  // Rows 2 and 3: both wired, so a data edge is at least conceivable.
  const candidate = bestPortPair(source, target, options);
  if (candidate.kind === 'compatible') {
    const promotable: ArrowPromotion = {
      from: { nodeId: source.id, portId: candidate.fromPortId },
      to: { nodeId: target.id, portId: candidate.toPortId },
    };
    if (candidate.adapter) promotable.adapter = candidate.adapter;
    return { class: 'annotation', promotable };
  }

  if (candidate.kind === 'rejected') {
    const res: DrawnArrowResolution = { class: 'annotation', reason: candidate.reason };
    if (candidate.fix) res.fix = candidate.fix;
    return res;
  }

  return { class: 'annotation' };
}

type PortPairResult =
  | { kind: 'compatible'; fromPortId: string; toPortId: string; adapter?: AdapterKind }
  | { kind: 'rejected'; reason: string; fix?: ConnectionFix }
  | { kind: 'none' };

/**
 * Picks the port pair a one-click promotion would use: the first compatible
 * pair, preferring required inputs, since that is what the analyst almost
 * always meant when they drew node-to-node.
 */
function bestPortPair(
  source: PicassoNode,
  target: PicassoNode,
  options: ResolveArrowOptions,
): PortPairResult {
  const outputs = options.hint?.fromPortId
    ? source.outputs.filter((p) => p.id === options.hint?.fromPortId)
    : source.outputs;
  const inputsAll = options.hint?.toPortId
    ? target.inputs.filter((p) => p.id === options.hint?.toPortId)
    : target.inputs;
  // Required inputs first: an arrow into a node usually means "feed this".
  const inputs = [...inputsAll].sort((a, b) => Number(b.required) - Number(a.required));

  let firstRejection: PortPairResult | undefined;

  for (const out of outputs) {
    for (const inp of inputs) {
      const result = validateConnection(source, out.id, target, inp.id, options);
      if (result.ok) {
        return result.adapter === undefined
          ? { kind: 'compatible', fromPortId: out.id, toPortId: inp.id }
          : { kind: 'compatible', fromPortId: out.id, toPortId: inp.id, adapter: result.adapter };
      }
      // Keep the most explanatory rejection, not a structural one like
      // "port already occupied", which says nothing about the analyst's intent.
      if (!firstRejection && isExplanatory(result.code)) {
        firstRejection = result.fix
          ? { kind: 'rejected', reason: result.message, fix: result.fix }
          : { kind: 'rejected', reason: result.message };
      }
    }
  }

  return firstRejection ?? { kind: 'none' };
}

function isExplanatory(code: string): boolean {
  return (
    code === 'type_mismatch' ||
    code === 'frequency_mismatch' ||
    code === 'currency_mismatch' ||
    code === 'asset_class_mismatch' ||
    code === 'insufficient_history' ||
    code === 'unverified_input' ||
    code === 'cycle'
  );
}

/**
 * Turns a promotable annotation into a real data edge. Requires the analyst's
 * click: there is no path from `resolveDrawnArrow` to this function.
 */
export function promoteAnnotationToData(edge: Edge, promotion: ArrowPromotion): Edge {
  const next: Edge = {
    ...edge,
    class: 'data',
    from: promotion.from,
    to: promotion.to,
  };
  if (promotion.adapter) next.adapter = promotion.adapter;
  else delete next.adapter;
  return next;
}
