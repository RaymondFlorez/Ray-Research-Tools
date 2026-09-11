/**
 * Dataflow graph: topological order, dirty propagation and viewport-scoped
 * scheduling (PRD 3.4).
 *
 * Evaluation is pull-based with push invalidation. A change marks the changed
 * node stale and pushes invalidation transitively to descendants; only nodes in
 * or near the viewport, explicitly pinned, or upstream of one of those, are
 * scheduled. Everything else stays stale until it is needed, which is what makes
 * a 10,000-node canvas viable.
 *
 * Only `data` edges carry dataflow. Reference, causal and annotation edges carry
 * meaning, not values, so they never schedule work and never form a cycle here.
 */

import type { CanvasDocument, Edge, NodeID, PicassoNode } from './types.js';

export class CycleError extends Error {
  constructor(readonly cycle: NodeID[]) {
    super(`Dataflow cycle: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
  }
}

export interface Adjacency {
  /** node -> nodes it feeds. */
  out: Map<NodeID, Set<NodeID>>;
  /** node -> nodes that feed it. */
  in: Map<NodeID, Set<NodeID>>;
}

export function dataEdges(doc: CanvasDocument): Edge[] {
  return [...doc.edges.values()].filter((e) => e.class === 'data');
}

export function buildAdjacency(doc: CanvasDocument): Adjacency {
  const out = new Map<NodeID, Set<NodeID>>();
  const inn = new Map<NodeID, Set<NodeID>>();
  for (const id of doc.nodes.keys()) {
    out.set(id, new Set());
    inn.set(id, new Set());
  }
  for (const e of dataEdges(doc)) {
    if (!doc.nodes.has(e.from.nodeId) || !doc.nodes.has(e.to.nodeId)) continue;
    out.get(e.from.nodeId)?.add(e.to.nodeId);
    inn.get(e.to.nodeId)?.add(e.from.nodeId);
  }
  return { out, in: inn };
}

/**
 * Kahn's algorithm. Throws `CycleError` naming one cycle, because the general
 * DAG forbids cycles (PRD 3.4.4) and the analyst needs to see which wire closed
 * the loop, not a generic failure.
 */
export function topologicalOrder(doc: CanvasDocument, adjacency?: Adjacency): NodeID[] {
  const adj = adjacency ?? buildAdjacency(doc);
  const indegree = new Map<NodeID, number>();
  for (const [id, preds] of adj.in) indegree.set(id, preds.size);

  const queue: NodeID[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);

  const order: NodeID[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as NodeID;
    order.push(id);
    for (const next of adj.out.get(id) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (order.length !== doc.nodes.size) {
    const remaining = new Set([...doc.nodes.keys()].filter((id) => !order.includes(id)));
    throw new CycleError(findCycle(adj, remaining));
  }
  return order;
}

function findCycle(adj: Adjacency, candidates: Set<NodeID>): NodeID[] {
  const seen = new Map<NodeID, number>();
  const stack: NodeID[] = [];

  const walk = (id: NodeID): NodeID[] | undefined => {
    const state = seen.get(id) ?? 0;
    if (state === 1) return [...stack.slice(stack.indexOf(id)), id];
    if (state === 2) return undefined;
    seen.set(id, 1);
    stack.push(id);
    for (const next of adj.out.get(id) ?? []) {
      if (!candidates.has(next)) continue;
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    seen.set(id, 2);
    return undefined;
  };

  for (const id of candidates) {
    const found = walk(id);
    if (found) return found;
  }
  return [...candidates];
}

/** True when a data edge source -> target would close a cycle. */
export function wouldCreateCycle(doc: CanvasDocument, from: NodeID, to: NodeID): boolean {
  if (from === to) return true;
  const adj = buildAdjacency(doc);
  // A cycle appears exactly when `from` is already reachable from `to`.
  const stack: NodeID[] = [to];
  const seen = new Set<NodeID>([to]);
  while (stack.length > 0) {
    const id = stack.pop() as NodeID;
    if (id === from) return true;
    for (const next of adj.out.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

export function descendants(doc: CanvasDocument, roots: Iterable<NodeID>, adjacency?: Adjacency): Set<NodeID> {
  const adj = adjacency ?? buildAdjacency(doc);
  const out = new Set<NodeID>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as NodeID;
    for (const next of adj.out.get(id) ?? []) {
      if (out.has(next)) continue;
      out.add(next);
      stack.push(next);
    }
  }
  return out;
}

export function ancestors(doc: CanvasDocument, roots: Iterable<NodeID>, adjacency?: Adjacency): Set<NodeID> {
  const adj = adjacency ?? buildAdjacency(doc);
  const out = new Set<NodeID>();
  const stack = [...roots];
  while (stack.length > 0) {
    const id = stack.pop() as NodeID;
    for (const prev of adj.in.get(id) ?? []) {
      if (out.has(prev)) continue;
      out.add(prev);
      stack.push(prev);
    }
  }
  return out;
}

export interface InvalidationResult {
  /** Every node newly marked stale, the changed node included. */
  marked: Set<NodeID>;
  /** Loose nodes reached by the walk and deliberately skipped. */
  skippedLoose: Set<NodeID>;
}

/**
 * Push invalidation. Marks the changed node stale and propagates transitively to
 * descendants. Loose objects are skipped and do not propagate: they never enter
 * the scheduler, never mark anything stale and never hold a cache key.
 */
export function markStale(
  doc: CanvasDocument,
  changed: NodeID,
  adjacency?: Adjacency,
): InvalidationResult {
  const adj = adjacency ?? buildAdjacency(doc);
  const marked = new Set<NodeID>();
  const skippedLoose = new Set<NodeID>();
  const stack: NodeID[] = [changed];

  while (stack.length > 0) {
    const id = stack.pop() as NodeID;
    const node = doc.nodes.get(id);
    if (!node) continue;
    if (node.binding === 'loose') {
      skippedLoose.add(id);
      continue;
    }
    if (marked.has(id)) continue;
    marked.add(id);
    node.state = { ...node.state, status: 'stale' };
    delete node.state.cacheKey;
    for (const next of adj.out.get(id) ?? []) stack.push(next);
  }

  return { marked, skippedLoose };
}

export interface ScheduleInput {
  /** Nodes in or near the viewport, from the spatial index. */
  visible: Iterable<NodeID>;
  /** Explicitly pinned nodes, which evaluate even when off-screen. */
  pinned?: Iterable<NodeID>;
  /** Cap on concurrently computing nodes (PRD 7.3 target: 200). */
  concurrencyLimit?: number;
}

export interface ScheduleResult {
  /** Stale nodes to evaluate, in dependency order. */
  order: NodeID[];
  /** Stale nodes deliberately left alone because nothing needs them yet. */
  deferred: NodeID[];
  /**
   * PRD 3.6: off-screen nodes whose inputs changed accumulate an invalidation
   * counter shown on the minimap as a pressure indicator.
   */
  pressure: number;
}

/**
 * Builds the evaluation batch: stale nodes that are (a) in or near the viewport,
 * (b) pinned, or (c) upstream of something in (a) or (b).
 */
export function schedule(doc: CanvasDocument, input: ScheduleInput): ScheduleResult {
  const adj = buildAdjacency(doc);
  const order = topologicalOrder(doc, adj);

  const roots = new Set<NodeID>();
  for (const id of input.visible) if (doc.nodes.has(id)) roots.add(id);
  for (const id of input.pinned ?? []) if (doc.nodes.has(id)) roots.add(id);

  const needed = new Set<NodeID>(roots);
  for (const id of ancestors(doc, roots, adj)) needed.add(id);

  const wanted: NodeID[] = [];
  const deferred: NodeID[] = [];
  for (const id of order) {
    const node = doc.nodes.get(id) as PicassoNode;
    if (node.binding === 'loose') continue;
    if (node.state.status !== 'stale') continue;
    if (needed.has(id)) wanted.push(id);
    else deferred.push(id);
  }

  const limit = input.concurrencyLimit ?? Infinity;
  return {
    order: limit === Infinity ? wanted : wanted.slice(0, limit),
    deferred,
    pressure: deferred.length,
  };
}

/** Nodes whose every data input is ready, so they can start right now. */
export function readyToEvaluate(doc: CanvasDocument, batch: readonly NodeID[]): NodeID[] {
  const adj = buildAdjacency(doc);
  const batchSet = new Set(batch);
  return batch.filter((id) => {
    for (const dep of adj.in.get(id) ?? []) {
      if (batchSet.has(dep)) return false;
      const depNode = doc.nodes.get(dep);
      if (depNode && depNode.binding !== 'loose' && depNode.state.status !== 'ready') return false;
    }
    return true;
  });
}
