/**
 * The Yjs document schema (PRD 2.2, 3.9).
 *
 * "Separating ephemeral (hover, selection, viewport) from durable (graph
 * structure) avoids syncing 200 cursor updates per second through the CRDT."
 *
 * The line this schema draws is sharper than that, and it is the important one:
 * **the document syncs, the computation does not.** Node kind, position, params,
 * wiring and provenance are shared truth. `NodeRuntimeState` — status, cache
 * key, latency, cost — is per-client and never enters the CRDT, because it is
 * not a fact about the canvas, it is a fact about one browser's progress
 * through it. Two analysts looking at the same canvas can legitimately have the
 * same node `ready` and `computing` at once.
 *
 * Shape:
 *
 *   doc
 *   ├─ meta   Y.Map   canvas id, title, asof
 *   ├─ nodes  Y.Map<Y.Map>   id -> fields, params nested as a Y.Map
 *   ├─ edges  Y.Map<Y.Map>   id -> fields
 *   └─ ink    Y.Map<Y.Map>   id -> { color, width, committed, runs: Y.Array }
 *
 * Fields are stored individually rather than as one serialized blob so that two
 * people editing different properties of the same node merge instead of one
 * overwriting the other.
 */

import * as Y from 'yjs';
import type {
  BindingState,
  Edge,
  NodeKind,
  ParamValue,
  PicassoNode,
  ProvenanceRef,
} from '@picasso/canvas-core';
import type { InkStroke, PointRun } from '@picasso/canvas-ink';

export const NODES = 'nodes';
export const EDGES = 'edges';
export const INK = 'ink';
export const META = 'meta';

export type YNode = Y.Map<unknown>;
export type YEdge = Y.Map<unknown>;
export type YStroke = Y.Map<unknown>;

export function nodesOf(doc: Y.Doc): Y.Map<YNode> {
  return doc.getMap<YNode>(NODES);
}

export function edgesOf(doc: Y.Doc): Y.Map<YEdge> {
  return doc.getMap<YEdge>(EDGES);
}

export function inkOf(doc: Y.Doc): Y.Map<YStroke> {
  return doc.getMap<YStroke>(INK);
}

export function metaOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap<unknown>(META);
}

/** Node fields that live in the CRDT. Runtime state is deliberately absent. */
export interface SyncedNodeFields {
  kind: NodeKind;
  binding: BindingState;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  parentFrame?: string;
  inputs: PicassoNode['inputs'];
  outputs: PicassoNode['outputs'];
  entitlementTags: string[];
  createdBy: PicassoNode['createdBy'];
  agentTrace?: string;
  nodeVersion?: string;
  pinned?: boolean;
  frameMode?: PicassoNode['frameMode'];
  frozen?: PicassoNode['frozen'];
  provenance: ProvenanceRef;
}

export function toYNode(node: PicassoNode): YNode {
  const map: YNode = new Y.Map();
  map.set('kind', node.kind);
  map.set('binding', node.binding);
  map.set('x', node.position.x);
  map.set('y', node.position.y);
  map.set('w', node.size.w);
  map.set('h', node.size.h);
  map.set('z', node.z);
  map.set('inputs', node.inputs);
  map.set('outputs', node.outputs);
  map.set('entitlementTags', node.entitlementTags);
  map.set('createdBy', node.createdBy);
  map.set('provenance', node.provenance);
  if (node.parentFrame !== undefined) map.set('parentFrame', node.parentFrame);
  if (node.agentTrace !== undefined) map.set('agentTrace', node.agentTrace);
  if (node.nodeVersion !== undefined) map.set('nodeVersion', node.nodeVersion);
  if (node.pinned !== undefined) map.set('pinned', node.pinned);
  if (node.frameMode !== undefined) map.set('frameMode', node.frameMode);
  if (node.frozen !== undefined) map.set('frozen', node.frozen);

  // Params are their own map: two people setting different params on the same
  // node both land, rather than the later write replacing the whole object.
  const params = new Y.Map<ParamValue>();
  for (const [key, value] of Object.entries(node.params)) params.set(key, value);
  map.set('params', params);

  return map;
}

export function fromYNode(id: string, map: YNode): PicassoNode {
  const params: Record<string, ParamValue> = {};
  const yParams = map.get('params');
  if (yParams instanceof Y.Map) {
    for (const [key, value] of yParams.entries()) params[key] = value as ParamValue;
  }

  const node: PicassoNode = {
    id,
    kind: map.get('kind') as NodeKind,
    binding: map.get('binding') as BindingState,
    position: { x: map.get('x') as number, y: map.get('y') as number },
    size: { w: map.get('w') as number, h: map.get('h') as number },
    z: (map.get('z') as number) ?? 0,
    inputs: (map.get('inputs') as PicassoNode['inputs']) ?? [],
    outputs: (map.get('outputs') as PicassoNode['outputs']) ?? [],
    params,
    // Runtime state never syncs. A node arriving from another client has not
    // been computed here, so it starts stale unless it is loose.
    state: { status: map.get('binding') === 'loose' ? 'idle' : 'stale' },
    provenance: (map.get('provenance') as ProvenanceRef) ?? {
      datasetSnapshots: {},
      asof: '',
      verified: true,
    },
    entitlementTags: (map.get('entitlementTags') as string[]) ?? [],
    createdBy: (map.get('createdBy') as PicassoNode['createdBy']) ?? 'user',
  };

  const parentFrame = map.get('parentFrame');
  if (parentFrame !== undefined) node.parentFrame = parentFrame as string;
  const agentTrace = map.get('agentTrace');
  if (agentTrace !== undefined) node.agentTrace = agentTrace as string;
  const nodeVersion = map.get('nodeVersion');
  if (nodeVersion !== undefined) node.nodeVersion = nodeVersion as string;
  const pinned = map.get('pinned');
  if (pinned !== undefined) node.pinned = pinned as boolean;
  const frameMode = map.get('frameMode');
  if (frameMode !== undefined) node.frameMode = frameMode as NonNullable<PicassoNode['frameMode']>;
  const frozen = map.get('frozen');
  if (frozen !== undefined) node.frozen = frozen as NonNullable<PicassoNode['frozen']>;

  return node;
}

export function toYEdge(edge: Edge): YEdge {
  const map: YEdge = new Y.Map();
  map.set('fromNode', edge.from.nodeId);
  map.set('fromPort', edge.from.portId);
  map.set('toNode', edge.to.nodeId);
  map.set('toPort', edge.to.portId);
  map.set('class', edge.class);
  if (edge.adapter !== undefined) map.set('adapter', edge.adapter);
  if (edge.causal !== undefined) map.set('causal', edge.causal);
  if (edge.unverifiedOverride !== undefined) map.set('unverifiedOverride', edge.unverifiedOverride);
  return map;
}

export function fromYEdge(id: string, map: YEdge): Edge {
  const edge: Edge = {
    id,
    from: { nodeId: map.get('fromNode') as string, portId: map.get('fromPort') as string },
    to: { nodeId: map.get('toNode') as string, portId: map.get('toPort') as string },
    class: map.get('class') as Edge['class'],
  };
  const adapter = map.get('adapter');
  if (adapter !== undefined) edge.adapter = adapter as NonNullable<Edge['adapter']>;
  const causal = map.get('causal');
  if (causal !== undefined) edge.causal = causal as NonNullable<Edge['causal']>;
  const override = map.get('unverifiedOverride');
  if (override !== undefined) edge.unverifiedOverride = override as NonNullable<Edge['unverifiedOverride']>;
  return edge;
}

/**
 * Ink is stored as a Y.Array of runs, which is the CRDT-friendliest case there
 * is: appends from different clients interleave without conflict, because
 * nobody is editing what anybody else wrote.
 */
export function toYStroke(stroke: InkStroke): YStroke {
  const map: YStroke = new Y.Map();
  const runs = new Y.Array<PointRun>();
  runs.push(stroke.runs.map((r) => ({ points: r.points.map((p) => ({ ...p })) })));
  map.set('runs', runs);
  if (stroke.color !== undefined) map.set('color', stroke.color);
  if (stroke.width !== undefined) map.set('width', stroke.width);
  if (stroke.committed !== undefined) map.set('committed', stroke.committed);
  return map;
}

export function fromYStroke(id: string, map: YStroke): InkStroke {
  const runs = map.get('runs');
  const stroke: InkStroke = {
    id,
    runs: runs instanceof Y.Array ? (runs.toArray() as PointRun[]) : [],
  };
  const color = map.get('color');
  if (color !== undefined) stroke.color = color as string;
  const width = map.get('width');
  if (width !== undefined) stroke.width = width as number;
  const committed = map.get('committed');
  if (committed !== undefined) stroke.committed = committed as boolean;
  return stroke;
}
