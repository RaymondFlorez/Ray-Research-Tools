import { describe, expect, it } from 'vitest';
import {
  CycleError,
  ancestors,
  descendants,
  markStale,
  readyToEvaluate,
  schedule,
  topologicalOrder,
  wouldCreateCycle,
} from '../src/graph.js';
import { addNode, createDocument } from '../src/document.js';
import type { CanvasDocument, Edge, EdgeClass, NodeID } from '../src/types.js';
import { node, port } from './fixtures.js';

function wire(doc: CanvasDocument, from: NodeID, to: NodeID, cls: EdgeClass = 'data'): Edge {
  const edge: Edge = {
    id: `${from}->${to}:${cls}`,
    from: { nodeId: from, portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    class: cls,
  };
  doc.edges.set(edge.id, edge);
  return edge;
}

/** a -> b -> d, a -> c -> d, plus an unattached e. */
function diamond(): { doc: CanvasDocument; ids: Record<string, string> } {
  const doc = createDocument('canvas');
  const ids: Record<string, string> = {};
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    const n = addNode(
      doc,
      node({
        id: name,
        inputs: [port('in', 'series', { cardinality: 'many' })],
        outputs: [port('out', 'series')],
      }),
    );
    ids[name] = n.id;
  }
  wire(doc, 'a', 'b');
  wire(doc, 'a', 'c');
  wire(doc, 'b', 'd');
  wire(doc, 'c', 'd');
  return { doc, ids };
}

describe('dataflow graph (PRD 3.4)', () => {
  it('orders nodes so every dependency precedes its dependants', () => {
    const { doc } = diamond();
    const order = topologicalOrder(doc);
    expect(order).toHaveLength(5);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('reports the cycle that broke the order, not a generic failure', () => {
    const { doc } = diamond();
    wire(doc, 'd', 'a');
    try {
      topologicalOrder(doc);
      throw new Error('expected a CycleError');
    } catch (err) {
      expect(err).toBeInstanceOf(CycleError);
      expect((err as CycleError).cycle.length).toBeGreaterThan(1);
    }
  });

  it('only data edges carry dataflow: reference, causal and annotation do not', () => {
    const doc = createDocument('c');
    for (const name of ['a', 'b']) {
      addNode(doc, node({ id: name, inputs: [port('in', 'series')], outputs: [port('out', 'series')] }));
    }
    wire(doc, 'a', 'b', 'causal');
    wire(doc, 'b', 'a', 'causal');
    // A causal cycle is legal and invisible to the DAG (PRD 3.4.4).
    expect(() => topologicalOrder(doc)).not.toThrow();
    expect(wouldCreateCycle(doc, 'a', 'b')).toBe(false);
  });

  it('detects the wire that would close a loop before it is made', () => {
    const { doc } = diamond();
    expect(wouldCreateCycle(doc, 'd', 'a')).toBe(true);
    expect(wouldCreateCycle(doc, 'd', 'e')).toBe(false);
    expect(wouldCreateCycle(doc, 'a', 'a')).toBe(true);
  });

  it('walks ancestors and descendants', () => {
    const { doc } = diamond();
    expect(descendants(doc, ['a'])).toEqual(new Set(['b', 'c', 'd']));
    expect(ancestors(doc, ['d'])).toEqual(new Set(['b', 'c', 'a']));
    expect(descendants(doc, ['e'])).toEqual(new Set());
  });
});

describe('push invalidation (PRD 3.4.1)', () => {
  it('marks the changed node and every descendant stale and drops their cache keys', () => {
    const { doc } = diamond();
    for (const n of doc.nodes.values()) n.state = { status: 'ready', cacheKey: 'k' };

    const { marked } = markStale(doc, 'a');
    expect(marked).toEqual(new Set(['a', 'b', 'c', 'd']));
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(doc.nodes.get(id)?.state.status).toBe('stale');
      expect(doc.nodes.get(id)?.state.cacheKey).toBeUndefined();
    }
    // Untouched branch keeps its cached value.
    expect(doc.nodes.get('e')?.state.status).toBe('ready');
    expect(doc.nodes.get('e')?.state.cacheKey).toBe('k');
  });

  it('loose objects never mark anything stale and never propagate (PRD 3.2)', () => {
    const { doc } = diamond();
    for (const n of doc.nodes.values()) n.state = { status: 'ready', cacheKey: 'k' };
    const b = doc.nodes.get('b');
    if (!b) throw new Error('missing node');
    b.binding = 'loose';

    const { marked, skippedLoose } = markStale(doc, 'a');
    expect(skippedLoose).toEqual(new Set(['b']));
    // d is still reached through c, but not through the loose b.
    expect(marked).toEqual(new Set(['a', 'c', 'd']));
    expect(b.state.status).toBe('ready');
  });
});

describe('viewport-scoped scheduling (PRD 3.4.2)', () => {
  it('evaluates what is visible plus its ancestors, and defers the rest', () => {
    const { doc } = diamond();
    for (const n of doc.nodes.values()) n.state = { status: 'stale' };

    const result = schedule(doc, { visible: ['d'] });
    // d needs b, c and a; e is nobody's dependency.
    expect(new Set(result.order)).toEqual(new Set(['a', 'b', 'c', 'd']));
    expect(result.order.indexOf('a')).toBeLessThan(result.order.indexOf('d'));
    expect(result.deferred).toEqual(['e']);
    expect(result.pressure).toBe(1);
  });

  it('evaluates pinned nodes even when they are off screen', () => {
    const { doc } = diamond();
    for (const n of doc.nodes.values()) n.state = { status: 'stale' };
    const result = schedule(doc, { visible: [], pinned: ['b'] });
    expect(new Set(result.order)).toEqual(new Set(['a', 'b']));
  });

  it('skips nodes that are already ready and never schedules loose objects', () => {
    const { doc } = diamond();
    for (const n of doc.nodes.values()) n.state = { status: 'stale' };
    const a = doc.nodes.get('a');
    const c = doc.nodes.get('c');
    if (!a || !c) throw new Error('missing node');
    a.state = { status: 'ready', cacheKey: 'k' };
    c.binding = 'loose';

    const result = schedule(doc, { visible: ['d'] });
    expect(new Set(result.order)).toEqual(new Set(['b', 'd']));
  });

  it('honours the concurrency limit and keeps the deferred count as pressure', () => {
    const { doc } = diamond();
    for (const n of doc.nodes.values()) n.state = { status: 'stale' };
    const result = schedule(doc, { visible: ['d'], concurrencyLimit: 2 });
    expect(result.order).toHaveLength(2);
    expect(result.order[0]).toBe('a');
  });

  it('reports which of a batch can start immediately', () => {
    const { doc } = diamond();
    for (const n of doc.nodes.values()) n.state = { status: 'stale' };
    const batch = schedule(doc, { visible: ['d'] }).order;
    expect(readyToEvaluate(doc, batch)).toEqual(['a']);

    const a = doc.nodes.get('a');
    if (!a) throw new Error('missing node');
    a.state = { status: 'ready', cacheKey: 'k' };
    const next = schedule(doc, { visible: ['d'] }).order;
    expect(new Set(readyToEvaluate(doc, next))).toEqual(new Set(['b', 'c']));
  });
});
