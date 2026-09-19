/**
 * Canvas templates (PRD 3.9).
 *
 * > Canvas templates strip instrument bindings and keep structure, so a
 * > completed analysis re-runs against a new ticker in one action.
 *
 * The sentence is short and the claim in it is not. "Keep structure" is easy —
 * copy the nodes and the edges. "Strip instrument bindings" is where a template
 * is either useful or a quiet source of wrong answers, because a canvas that
 * has *run* carries the previous instrument in more places than the parameter
 * that names it:
 *
 * - **Computed values.** A cell holding NVDA's gross margin is not structure.
 * - **Cache keys.** A key derived against NVDA would let a node re-instantiated
 *   for MU serve NVDA's cached answer. This is the failure that matters: it is
 *   silent, it is fast, and the number is wrong.
 * - **Dataset snapshots and as-of stamps.** A template re-run next quarter that
 *   quietly reads last quarter's Iceberg snapshot is reproducing the old
 *   analysis, not running the new one.
 * - **Provenance and verification flags.** A node marked verified was verified
 *   against data that is no longer there.
 * - **Entitlement tags.** They belong to the data the node held, not to the
 *   shape of the node.
 *
 * So `toTemplate` removes all of it and `instantiate` asks for the bindings
 * back. A node whose instrument parameter is not supplied comes back `stale`
 * with nothing in it rather than carrying the old value forward, and
 * `missingBindings` names every one — because a template that silently
 * half-binds is worse than one that refuses.
 *
 * Positions are kept. The spatial arrangement of a canvas *is* the analysis in
 * a way a list of nodes is not: the reader built a layout, and a template that
 * discarded it would hand back the same graph as a pile.
 */

import type {
  CanvasDocument,
  Edge,
  NodeID,
  ParamValue,
  PicassoNode,
} from './types.js';
import { createDocument } from './document.js';

/** Parameter names that name an instrument rather than describe a method. */
export const INSTRUMENT_PARAMS: readonly string[] = [
  'instrument',
  'instruments',
  'symbol',
  'symbols',
  'ticker',
  'tickers',
  'underlier',
  'underliers',
  'universe',
  'portfolio',
];

export interface TemplateNode {
  id: NodeID;
  kind: PicassoNode['kind'];
  binding: PicassoNode['binding'];
  position: PicassoNode['position'];
  size: PicassoNode['size'];
  z: number;
  inputs: PicassoNode['inputs'];
  outputs: PicassoNode['outputs'];
  /** Everything that was not an instrument binding. */
  params: Record<string, ParamValue>;
  /** The instrument parameters this node needs supplied, by name. */
  bindings: string[];
  parentFrame?: NodeID;
  nodeVersion?: string;
  pinned?: boolean;
  frameMode?: PicassoNode['frameMode'];
}

export interface CanvasTemplate {
  /** What the template is called, for the palette. */
  name: string;
  /** The canvas it was taken from, so a template can be traced to its origin. */
  sourceCanvas: string;
  nodes: TemplateNode[];
  edges: Edge[];
  /** Every distinct binding name the template needs, across all nodes. */
  required: string[];
}

function stripParams(params: Record<string, ParamValue>): {
  kept: Record<string, ParamValue>;
  bindings: string[];
} {
  const kept: Record<string, ParamValue> = {};
  const bindings: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (INSTRUMENT_PARAMS.includes(name)) bindings.push(name);
    else kept[name] = value;
  }
  return { kept, bindings: bindings.sort() };
}

/** Take a template from a canvas, keeping structure and dropping the subject. */
export function toTemplate(doc: CanvasDocument, name: string): CanvasTemplate {
  const nodes: TemplateNode[] = [];
  const required = new Set<string>();

  for (const node of doc.nodes.values()) {
    const { kept, bindings } = stripParams(node.params);
    for (const binding of bindings) required.add(binding);
    nodes.push({
      id: node.id,
      kind: node.kind,
      binding: node.binding,
      position: { ...node.position },
      size: { ...node.size },
      z: node.z,
      inputs: node.inputs.map((p) => ({ ...p })),
      outputs: node.outputs.map((p) => ({ ...p })),
      params: kept,
      bindings,
      ...(node.parentFrame !== undefined ? { parentFrame: node.parentFrame } : {}),
      ...(node.nodeVersion !== undefined ? { nodeVersion: node.nodeVersion } : {}),
      ...(node.pinned !== undefined ? { pinned: node.pinned } : {}),
      ...(node.frameMode !== undefined ? { frameMode: node.frameMode } : {}),
    });
  }

  // Sorted so a template is a value: two templates taken from the same canvas
  // compare equal, and a diff between versions is readable.
  nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const edges = [...doc.edges.values()]
    .map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { name, sourceCanvas: doc.id, nodes, edges, required: [...required].sort() };
}

export interface InstantiateResult {
  doc: CanvasDocument;
  /**
   * Bindings the caller did not supply, as `nodeId.paramName`.
   *
   * A node in this list came back with no instrument at all and is `stale`. It
   * is not an error — a template may legitimately be instantiated in stages —
   * but it is never silent, because the alternative is a canvas that looks
   * complete and is computing nothing.
   */
  missingBindings: string[];
}

/**
 * Re-run a template against a new subject.
 *
 * Every node comes back `stale` with no cache key, no provenance, no dataset
 * snapshot and no verification flag, whatever the source canvas held. That is
 * the point rather than an omission: a key derived against the old instrument
 * would let a node instantiated for the new one serve the old one's cached
 * answer, which is silent, fast and wrong.
 */
export function instantiate(
  template: CanvasTemplate,
  bindings: Record<string, ParamValue>,
  canvasId: string,
): InstantiateResult {
  const doc = createDocument(canvasId);
  const missingBindings: string[] = [];

  for (const node of template.nodes) {
    const params: Record<string, ParamValue> = { ...node.params };
    for (const name of node.bindings) {
      if (name in bindings) params[name] = bindings[name] as ParamValue;
      else missingBindings.push(`${node.id}.${name}`);
    }

    const instantiated: PicassoNode = {
      id: node.id,
      kind: node.kind,
      binding: node.binding,
      position: { ...node.position },
      size: { ...node.size },
      z: node.z,
      inputs: node.inputs.map((p) => ({ ...p })),
      outputs: node.outputs.map((p) => ({ ...p })),
      params,
      // Loose objects never enter the scheduler, so they are idle rather than
      // stale — the same rule `createNode` applies.
      state: { status: node.binding === 'loose' ? 'idle' : 'stale' },
      provenance: { datasetSnapshots: {}, asof: '', verified: false },
      entitlementTags: [],
      createdBy: 'user',
      ...(node.parentFrame !== undefined ? { parentFrame: node.parentFrame } : {}),
      ...(node.nodeVersion !== undefined ? { nodeVersion: node.nodeVersion } : {}),
      ...(node.pinned !== undefined ? { pinned: node.pinned } : {}),
      ...(node.frameMode !== undefined ? { frameMode: node.frameMode } : {}),
    };
    doc.nodes.set(node.id, instantiated);
  }

  for (const edge of template.edges) {
    // An edge whose endpoints did not both survive is dropped rather than
    // carried as a dangling reference. It cannot happen from `toTemplate`,
    // which takes whole documents, and can from a hand-edited template.
    if (!doc.nodes.has(edge.from.nodeId) || !doc.nodes.has(edge.to.nodeId)) continue;
    doc.edges.set(edge.id, { ...edge, from: { ...edge.from }, to: { ...edge.to } });
  }

  return { doc, missingBindings: missingBindings.sort() };
}

/** Whether a template would instantiate completely under these bindings. */
export function bindingsSatisfy(
  template: CanvasTemplate,
  bindings: Record<string, ParamValue>,
): boolean {
  return template.required.every((name) => name in bindings);
}
