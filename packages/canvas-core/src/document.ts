/**
 * Canvas document helpers and the spatial index that sits over it.
 *
 * One document holds loose, bound and wired objects together: one selection
 * model, one undo stack, one index (PRD 3.2.6, guardrail #1). Nothing here
 * changes a binding state; that lives in `binding.ts` behind an explicit commit.
 */

import type {
  CanvasDocument,
  Edge,
  EdgeID,
  NodeID,
  PicassoNode,
  Port,
  Vec2,
} from './types.js';
import { RTree } from './spatial.js';
import { cullRect, type Rect, type Viewport } from './viewport.js';
import { markStale, wouldCreateCycle } from './graph.js';
import { validateConnection, type ConnectionResult, type ValidateOptions } from './ports.js';

export function createDocument(id: string): CanvasDocument {
  return { id, nodes: new Map(), edges: new Map() };
}

export interface CreateNodeInput extends Partial<Omit<PicassoNode, 'id' | 'kind'>> {
  id: NodeID;
  kind: PicassoNode['kind'];
}

/** Builds a node with the defaults a freshly created object carries. */
export function createNode(input: CreateNodeInput): PicassoNode {
  // Resolve the binding first: a loose object is idle, never stale, because it
  // never enters the scheduler and has nothing to recompute.
  const binding = input.binding ?? 'loose';
  const node: PicassoNode = {
    id: input.id,
    kind: input.kind,
    binding,
    position: input.position ?? { x: 0, y: 0 },
    size: input.size ?? { w: 240, h: 160 },
    z: input.z ?? 0,
    inputs: input.inputs ?? [],
    outputs: input.outputs ?? [],
    params: input.params ?? {},
    state: input.state ?? { status: binding === 'loose' ? 'idle' : 'stale' },
    provenance: input.provenance ?? { datasetSnapshots: {}, asof: '', verified: true },
    entitlementTags: input.entitlementTags ?? [],
    createdBy: input.createdBy ?? 'user',
  };
  if (input.parentFrame !== undefined) node.parentFrame = input.parentFrame;
  if (input.agentTrace !== undefined) node.agentTrace = input.agentTrace;
  if (input.nodeVersion !== undefined) node.nodeVersion = input.nodeVersion;
  if (input.pinned !== undefined) node.pinned = input.pinned;
  if (input.frameMode !== undefined) node.frameMode = input.frameMode;
  if (input.frozen !== undefined) node.frozen = input.frozen;
  return node;
}

export function addNode(doc: CanvasDocument, node: PicassoNode): PicassoNode {
  doc.nodes.set(node.id, node);
  return node;
}

/** Removes a node and every edge touching it. Returns the removed edges. */
export function removeNode(doc: CanvasDocument, nodeId: NodeID): Edge[] {
  const removed: Edge[] = [];
  for (const [id, edge] of doc.edges) {
    if (edge.from.nodeId === nodeId || edge.to.nodeId === nodeId) {
      removed.push(edge);
      doc.edges.delete(id);
    }
  }
  doc.nodes.delete(nodeId);
  // Downstream of a deleted node is stale by definition.
  for (const edge of removed) {
    if (edge.class === 'data' && edge.from.nodeId === nodeId) {
      markStale(doc, edge.to.nodeId);
    }
  }
  return removed;
}

export interface ConnectInput {
  id: EdgeID;
  from: { nodeId: NodeID; portId: string };
  to: { nodeId: NodeID; portId: string };
}

export type ConnectResult =
  | { ok: true; edge: Edge; invalidated: Set<NodeID> }
  | { ok: false; rejection: Extract<ConnectionResult, { ok: false }> };

/**
 * Validates and adds a `data` edge, then pushes invalidation downstream.
 * The rejection path returns the reason and the fix so the UI can show both
 * inline; it never adds a partial edge.
 */
export function connect(
  doc: CanvasDocument,
  input: ConnectInput,
  options: Omit<ValidateOptions, 'edges' | 'wouldCreateCycle'> = {},
): ConnectResult {
  const source = doc.nodes.get(input.from.nodeId);
  const target = doc.nodes.get(input.to.nodeId);
  if (!source || !target) {
    return {
      ok: false,
      rejection: { ok: false, code: 'unknown_port', message: 'Endpoint node is not on the canvas.' },
    };
  }

  const result = validateConnection(source, input.from.portId, target, input.to.portId, {
    ...options,
    edges: [...doc.edges.values()],
    wouldCreateCycle: (from, to) => wouldCreateCycle(doc, from, to),
  });
  if (!result.ok) return { ok: false, rejection: result };

  const edge: Edge = { id: input.id, from: input.from, to: input.to, class: 'data' };
  if (result.adapter) edge.adapter = result.adapter;
  doc.edges.set(edge.id, edge);

  const { marked } = markStale(doc, target.id);
  return { ok: true, edge, invalidated: marked };
}

/** Removes an edge and marks what it fed stale. */
export function disconnect(doc: CanvasDocument, edgeId: EdgeID): Edge | undefined {
  const edge = doc.edges.get(edgeId);
  if (!edge) return undefined;
  doc.edges.delete(edgeId);
  if (edge.class === 'data') markStale(doc, edge.to.nodeId);
  return edge;
}

export function nodeRect(node: PicassoNode): Rect {
  return {
    minX: node.position.x,
    minY: node.position.y,
    maxX: node.position.x + node.size.w,
    maxY: node.position.y + node.size.h,
  };
}

export function inputPorts(node: PicassoNode): readonly Port[] {
  return node.binding === 'wired' ? node.inputs : [];
}

export function outputPorts(node: PicassoNode): readonly Port[] {
  return node.binding === 'wired' ? node.outputs : [];
}

/**
 * The spatial index the renderer queries every frame. Kept in sync
 * incrementally on move and resize rather than rebuilt.
 */
export class CanvasIndex {
  private tree = new RTree<NodeID>();

  constructor(doc?: CanvasDocument) {
    if (doc) this.rebuild(doc);
  }

  rebuild(doc: CanvasDocument): void {
    this.tree.clear();
    for (const node of doc.nodes.values()) this.tree.insert(node.id, nodeRect(node));
  }

  upsert(node: PicassoNode): void {
    this.tree.insert(node.id, nodeRect(node));
  }

  remove(nodeId: NodeID): void {
    this.tree.remove(nodeId);
  }

  get size(): number {
    return this.tree.size;
  }

  /** Ids whose bounds intersect `rect`. */
  query(rect: Rect): NodeID[] {
    return this.tree.search(rect);
  }

  /** Ids inside the viewport grown by the cull margin (PRD 3.1). */
  visible(vp: Viewport, marginScreens?: number): NodeID[] {
    return this.tree.search(cullRect(vp, marginScreens));
  }

  /** Topmost node at a world point, for hit testing. */
  hit(doc: CanvasDocument, world: Vec2): PicassoNode | undefined {
    const candidates = this.tree.search({
      minX: world.x,
      minY: world.y,
      maxX: world.x,
      maxY: world.y,
    });
    let best: PicassoNode | undefined;
    for (const id of candidates) {
      const node = doc.nodes.get(id);
      if (!node) continue;
      if (!best || node.z > best.z) best = node;
    }
    return best;
  }
}

/** Moves a node and keeps the index consistent in one call. */
export function moveNode(
  doc: CanvasDocument,
  index: CanvasIndex,
  nodeId: NodeID,
  position: Vec2,
): PicassoNode | undefined {
  const node = doc.nodes.get(nodeId);
  if (!node) return undefined;
  node.position = position;
  index.upsert(node);
  return node;
}

/** Resizes a node and keeps the index consistent in one call. */
export function resizeNode(
  doc: CanvasDocument,
  index: CanvasIndex,
  nodeId: NodeID,
  size: { w: number; h: number },
): PicassoNode | undefined {
  const node = doc.nodes.get(nodeId);
  if (!node) return undefined;
  node.size = size;
  index.upsert(node);
  return node;
}
