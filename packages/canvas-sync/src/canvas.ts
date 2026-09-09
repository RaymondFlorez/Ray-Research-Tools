/**
 * The synced canvas: a Yjs document with the Picasso document model over it.
 *
 * Every mutation runs inside a Yjs transaction with an origin tag, so a change
 * arriving from the network can be told apart from one the local analyst made.
 * That distinction is what keeps the undo stack honest: undo should take back
 * what you did, never what your colleague did (PRD 3.2.6, guardrail #1).
 */

import * as Y from 'yjs';
import type {
  CanvasDocument,
  Edge,
  EdgeID,
  NodeID,
  ParamValue,
  PicassoNode,
  Vec2,
} from '@picasso/canvas-core';
import type { InkPoint, InkStroke, PointRun } from '@picasso/canvas-ink';
import {
  edgesOf,
  fromYEdge,
  fromYNode,
  fromYStroke,
  inkOf,
  metaOf,
  nodesOf,
  toYEdge,
  toYNode,
  toYStroke,
  type YNode,
  type YStroke,
} from './schema.js';

/** Marks a transaction as this client's own work. */
export const LOCAL_ORIGIN = 'local';
/** Marks a transaction as replayed from another client. */
export const REMOTE_ORIGIN = 'remote';

export interface SyncedCanvasOptions {
  doc?: Y.Doc;
  id?: string;
}

export class SyncedCanvas {
  readonly doc: Y.Doc;
  /** Undoes only local work; remote edits are out of scope by construction. */
  readonly undo: Y.UndoManager;

  constructor(options: SyncedCanvasOptions = {}) {
    this.doc = options.doc ?? new Y.Doc();
    if (options.id !== undefined) metaOf(this.doc).set('id', options.id);

    this.undo = new Y.UndoManager(
      [nodesOf(this.doc), edgesOf(this.doc), inkOf(this.doc)],
      {
        trackedOrigins: new Set([LOCAL_ORIGIN]),
        // Yjs defaults to merging everything within 500ms into one undo step.
        // On a canvas that is wrong: three nodes added in quick succession are
        // three actions, and undoing all of them because they happened inside
        // half a second is exactly the unpredictability guardrail #1 forbids.
        // One transaction is one step, and `transact` decides what a
        // transaction is.
        captureTimeout: 0,
      },
    );
  }

  get id(): string {
    return (metaOf(this.doc).get('id') as string) ?? this.doc.guid;
  }

  /** Runs `fn` as one atomic, undoable local change. */
  transact<T>(fn: () => T, origin: unknown = LOCAL_ORIGIN): T {
    return this.doc.transact(fn, origin);
  }

  // Nodes ---------------------------------------------------------------

  addNode(node: PicassoNode): void {
    this.transact(() => nodesOf(this.doc).set(node.id, toYNode(node)));
  }

  getNode(id: NodeID): PicassoNode | undefined {
    const map = nodesOf(this.doc).get(id);
    return map ? fromYNode(id, map) : undefined;
  }

  /**
   * Removes a node and every edge touching it, in one transaction. Doing this
   * atomically matters: half-applied, the document briefly holds an edge whose
   * endpoint does not exist, and every peer would render that state.
   */
  removeNode(id: NodeID): void {
    this.transact(() => {
      nodesOf(this.doc).delete(id);
      const edges = edgesOf(this.doc);
      for (const [edgeId, map] of [...edges.entries()]) {
        if (map.get('fromNode') === id || map.get('toNode') === id) edges.delete(edgeId);
      }
    });
  }

  moveNode(id: NodeID, position: Vec2): void {
    this.withNode(id, (map) => {
      map.set('x', position.x);
      map.set('y', position.y);
    });
  }

  resizeNode(id: NodeID, size: { w: number; h: number }): void {
    this.withNode(id, (map) => {
      map.set('w', size.w);
      map.set('h', size.h);
    });
  }

  setBinding(id: NodeID, binding: PicassoNode['binding']): void {
    this.withNode(id, (map) => map.set('binding', binding));
  }

  /** Sets one param. Concurrent sets of *different* params both survive. */
  setParam(id: NodeID, key: string, value: ParamValue): void {
    this.withNode(id, (map) => {
      const params = map.get('params');
      if (params instanceof Y.Map) params.set(key, value);
    });
  }

  private withNode(id: NodeID, fn: (map: YNode) => void): void {
    const map = nodesOf(this.doc).get(id);
    if (!map) return;
    this.transact(() => fn(map));
  }

  // Edges ---------------------------------------------------------------

  addEdge(edge: Edge): void {
    this.transact(() => edgesOf(this.doc).set(edge.id, toYEdge(edge)));
  }

  removeEdge(id: EdgeID): void {
    this.transact(() => edgesOf(this.doc).delete(id));
  }

  // Ink -----------------------------------------------------------------

  /** Starts a stroke. Runs are appended afterwards, never rewritten. */
  addStroke(stroke: InkStroke): void {
    this.transact(() => inkOf(this.doc).set(stroke.id, toYStroke(stroke)));
  }

  /** Appends one run: the batch of coalesced samples from one pointer event. */
  appendRun(strokeId: string, run: PointRun): void {
    this.withStroke(strokeId, (map) => {
      const runs = map.get('runs');
      if (runs instanceof Y.Array) runs.push([{ points: run.points.map((p) => ({ ...p })) }]);
    });
  }

  /**
   * Pen lift. Replaces the accumulated runs with one simplified run.
   *
   * This is the single place ink is not append-only, and it is a deliberate
   * exception: a 240Hz capture holds far more points than the shape does, and
   * every one of them syncs and persists forever. It is safe because a
   * committed stroke is finished — no other client is appending to it — and it
   * happens once, at the end.
   */
  commitStroke(strokeId: string, points: readonly InkPoint[]): void {
    this.withStroke(strokeId, (map) => {
      const runs = map.get('runs');
      if (!(runs instanceof Y.Array)) return;
      runs.delete(0, runs.length);
      runs.push([{ points: points.map((p) => ({ ...p })) }]);
      map.set('committed', true);
    });
  }

  getStroke(id: string): InkStroke | undefined {
    const map = inkOf(this.doc).get(id);
    return map ? fromYStroke(id, map) : undefined;
  }

  removeStroke(id: string): void {
    this.transact(() => inkOf(this.doc).delete(id));
  }

  private withStroke(id: string, fn: (map: YStroke) => void): void {
    const map = inkOf(this.doc).get(id);
    if (!map) return;
    this.transact(() => fn(map));
  }

  // Reading -------------------------------------------------------------

  /**
   * Materializes the plain document model the rest of the system works on.
   * Runtime state is local: nodes come back stale, to be scheduled by this
   * client's own orchestrator.
   */
  snapshot(): CanvasDocument {
    const nodes = new Map<NodeID, PicassoNode>();
    for (const [id, map] of nodesOf(this.doc).entries()) nodes.set(id, fromYNode(id, map));

    const edges = new Map<EdgeID, Edge>();
    for (const [id, map] of edgesOf(this.doc).entries()) edges.set(id, fromYEdge(id, map));

    return { id: this.id, nodes, edges };
  }

  strokes(): InkStroke[] {
    return [...inkOf(this.doc).entries()].map(([id, map]) => fromYStroke(id, map));
  }

  get nodeCount(): number {
    return nodesOf(this.doc).size;
  }

  get edgeCount(): number {
    return edgesOf(this.doc).size;
  }

  get strokeCount(): number {
    return inkOf(this.doc).size;
  }

  /**
   * Observes document changes. The callback receives whether the change came
   * from this client, so a renderer can skip re-laying-out on its own edits.
   */
  observe(callback: (event: { local: boolean; origin: unknown }) => void): () => void {
    const handler = (_events: unknown, transaction: Y.Transaction): void => {
      callback({ local: transaction.origin === LOCAL_ORIGIN, origin: transaction.origin });
    };
    const targets = [nodesOf(this.doc), edgesOf(this.doc), inkOf(this.doc)];
    for (const target of targets) target.observeDeep(handler);
    return () => {
      for (const target of targets) target.unobserveDeep(handler);
    };
  }

  destroy(): void {
    this.undo.destroy();
    this.doc.destroy();
  }
}
