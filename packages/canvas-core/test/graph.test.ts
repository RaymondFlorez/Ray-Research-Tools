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

// ---------------------------------------------------------------------------
// PRD 7.1: "recompute deferred to drag-end"
// ---------------------------------------------------------------------------

describe('a drag holds its subtree back', () => {
  /** A chain: the dragged node feeding `depth` descendants, all wired. */
  function chain(depth: number) {
    const doc = createDocument('drag');
    const ids: NodeID[] = [];
    for (let i = 0; i <= depth; i += 1) {
      const id = `n${i}`;
      ids.push(id);
      addNode(
        doc,
        node({
          id,
          binding: 'wired',
          inputs: [port('in', 'series', { cardinality: 'many', required: false })],
          outputs: [port('out', 'series')],
        }),
      );
      if (i > 0) wire(doc, `n${i - 1}`, id);
    }
    return { doc, ids };
  }

  it('holds the dragged node and everything below it', () => {
    const { doc, ids } = chain(20);
    markStale(doc, 'n0');
    const result = schedule(doc, { visible: ids, dragging: ['n0'] });

    expect(result.order).toEqual([]);
    expect(result.heldByDrag.length).toBe(21);
    expect(new Set(result.heldByDrag)).toEqual(new Set(ids));
  });

  it('computes the same batch the moment the hand comes off', () => {
    const { doc, ids } = chain(20);
    markStale(doc, 'n0');
    const during = schedule(doc, { visible: ids, dragging: ['n0'] });
    const after = schedule(doc, { visible: ids });

    expect(during.order).toEqual([]);
    expect(after.order.length).toBe(21);
    // Nothing was lost: what the drag held is exactly what runs afterwards.
    expect(new Set(during.heldByDrag)).toEqual(new Set(after.order));
    // And in dependency order, so the chain still evaluates top down.
    expect(after.order[0]).toBe('n0');
    expect(after.order[after.order.length - 1]).toBe('n20');
  });

  // Invalidation is not suppressed, only evaluation. The canvas shows the
  // subtree stale while the hand is down, which is the honest state — the
  // numbers on screen no longer follow from the inputs.
  it('leaves the subtree stale rather than pretending it is current', () => {
    const { doc, ids } = chain(20);
    markStale(doc, 'n0');
    schedule(doc, { visible: ids, dragging: ['n0'] });
    for (const id of ids) {
      expect(doc.nodes.get(id)?.state.status, id).toBe('stale');
    }
  });

  it('does not hold a node that is merely near the drag', () => {
    const { doc, ids } = chain(6);
    // A sibling fed by the same upstream node but not below the dragged one.
    addNode(
      doc,
      node({
        id: 'sibling',
        binding: 'wired',
        inputs: [port('in', 'series', { cardinality: 'many', required: false })],
        outputs: [port('out', 'series')],
      }),
    );
    wire(doc, 'n0', 'sibling');
    markStale(doc, 'n0');

    // Drag n3: n4, n5, n6 are below it; the sibling is not.
    const result = schedule(doc, { visible: [...ids, 'sibling'], dragging: ['n3'] });
    expect(new Set(result.heldByDrag)).toEqual(new Set(['n3', 'n4', 'n5', 'n6']));
    expect(result.order).toContain('sibling');
    expect(result.order).toContain('n0');
  });

  it('holds nothing when nothing is being dragged', () => {
    const { doc, ids } = chain(5);
    markStale(doc, 'n0');
    const result = schedule(doc, { visible: ids });
    expect(result.heldByDrag).toEqual([]);
    expect(result.order.length).toBe(6);
  });

  it('separates what a drag holds from what nothing needs yet', () => {
    const { doc, ids } = chain(8);
    markStale(doc, 'n0');
    // Only the first four are on screen, and the drag is on n1.
    const visible = ids.slice(0, 4);
    const result = schedule(doc, { visible, dragging: ['n1'] });

    // n1..n8 are below the drag; n0 is on screen and above it.
    expect(result.order).toEqual(['n0']);
    expect(new Set(result.heldByDrag)).toEqual(new Set(ids.slice(1)));
    // A node is counted once. The two reasons are different claims about why a
    // node is not computing, and a node must not appear under both.
    for (const id of result.heldByDrag) expect(result.deferred).not.toContain(id);
  });

  it('ignores a dragged id that is not in the document', () => {
    const { doc, ids } = chain(3);
    markStale(doc, 'n0');
    const result = schedule(doc, { visible: ids, dragging: ['ghost'] });
    expect(result.heldByDrag).toEqual([]);
    expect(result.order.length).toBe(4);
  });
});
