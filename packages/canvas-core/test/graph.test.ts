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

// ---------------------------------------------------------------------------
// PRD 7.3: "concurrency limits with priority by viewport distance"
// ---------------------------------------------------------------------------

describe('the concurrency cap spends its budget on what the analyst can see', () => {
  const VIEWPORT = { x: 0, y: 0, scale: 1, width: 1000, height: 800 };

  /**
   * Independent nodes spread along x, so distance from the viewport is the
   * only thing that can order them — and deliberately created in the *reverse*
   * order, so topological order and distance order disagree. A cap that sorted
   * topologically would take the far ones.
   */
  function spread(count: number) {
    const doc = createDocument('spread');
    const ids: NodeID[] = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const id = `n${i}`;
      ids.unshift(id);
      const created = addNode(
        doc,
        node({ id, binding: 'wired', x: i * 400, y: 0, w: 200, h: 100 }),
      );
      created.state = { status: 'stale' };
    }
    return { doc, ids };
  }

  it('takes the nearest nodes, not the first ones', () => {
    const { doc, ids } = spread(40);
    const result = schedule(doc, {
      visible: ids,
      concurrencyLimit: 5,
      viewport: VIEWPORT,
    });

    expect(result.order.length).toBe(5);
    // n0..n4 are the five closest to a viewport at the origin.
    expect(new Set(result.order)).toEqual(new Set(['n0', 'n1', 'n2', 'n3', 'n4']));
  });

  it('follows the viewport when it moves', () => {
    const { doc, ids } = spread(40);
    const far = schedule(doc, {
      visible: ids,
      concurrencyLimit: 3,
      viewport: { ...VIEWPORT, x: 12_000 },
    });
    // Nodes sit at x = i * 400, so a viewport at 12,000 spanning 1,000 covers
    // n30 through n32.
    expect(new Set(far.order)).toEqual(new Set(['n30', 'n31', 'n32']));
  });

  it('keeps the old behaviour when no viewport is given', () => {
    const { doc, ids } = spread(40);
    const result = schedule(doc, { visible: ids, concurrencyLimit: 5 });
    expect(result.order.length).toBe(5);
    // Topological order, which for these independent nodes is creation order.
    expect(result.order).toEqual(['n39', 'n38', 'n37', 'n36', 'n35']);
  });

  it('does nothing when everything fits', () => {
    const { doc, ids } = spread(10);
    const capped = schedule(doc, { visible: ids, concurrencyLimit: 50, viewport: VIEWPORT });
    const uncapped = schedule(doc, { visible: ids });
    expect(capped.order).toEqual(uncapped.order);
  });

  /**
   * The constraint that makes this more than a sort: a node cannot evaluate
   * before its inputs.
   */
  describe('with dependencies', () => {
    /** A far chain feeding a near node, plus near independents. */
    function chainIntoNear() {
      const doc = createDocument('chain');
      const ids: NodeID[] = [];
      // The chain sits far away: c0 -> c1 -> ... -> c5 -> near.
      for (let i = 0; i < 6; i += 1) {
        const id = `c${i}`;
        ids.push(id);
        addNode(doc, node({ id, binding: 'wired', x: 40_000 + i * 300, y: 0, w: 200, h: 100 })).state = { status: 'stale' };
      }
      addNode(doc, node({ id: 'near', binding: 'wired', x: 0, y: 0, w: 200, h: 100 })).state = { status: 'stale' };
      ids.push('near');
      for (let i = 1; i < 6; i += 1) wire(doc, `c${i - 1}`, `c${i}`);
      wire(doc, 'c5', 'near');
      // Independent near nodes, further out than `near` but nearer than the chain.
      for (let i = 0; i < 4; i += 1) {
        const id = `alone${i}`;
        ids.push(id);
        addNode(doc, node({ id, binding: 'wired', x: 2_000 + i * 300, y: 0, w: 200, h: 100 })).state = { status: 'stale' };
      }
      return { doc, ids };
    }

    it('brings a near node\'s far ancestors with it', () => {
      const { doc, ids } = chainIntoNear();
      const result = schedule(doc, { visible: ids, concurrencyLimit: 7, viewport: VIEWPORT });

      // `near` is closest, so its whole chain comes too — seven slots, exactly.
      expect(new Set(result.order)).toEqual(
        new Set(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'near']),
      );
      // And the chain runs in dependency order, not in distance order.
      expect(result.order).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'near']);
    });

    // Selection is by distance; emission is topological. Ranking decides what
    // is in the batch, the DAG decides what order it runs in.
    it('emits topologically even though it selected by distance', () => {
      const { doc, ids } = chainIntoNear();
      const result = schedule(doc, { visible: ids, concurrencyLimit: 11, viewport: VIEWPORT });
      const position = new Map(result.order.map((id, i) => [id, i]));
      for (let i = 1; i < 6; i += 1) {
        expect(position.get(`c${i}`)).toBeGreaterThan(position.get(`c${i - 1}`) as number);
      }
      expect(position.get('near')).toBeGreaterThan(position.get('c5') as number);
    });

    // Progress toward the thing the analyst is looking at beats finishing
    // something further away that happens to be cheaper.
    it('takes part of a chain that does not fit whole, as a prefix', () => {
      const { doc, ids } = chainIntoNear();
      const result = schedule(doc, { visible: ids, concurrencyLimit: 3, viewport: VIEWPORT });

      expect(result.order).toEqual(['c0', 'c1', 'c2']);
      // Not `near` itself — it cannot run yet — and not the cheap independents,
      // which would have been three finished nodes and no progress at all.
      expect(result.order).not.toContain('near');
      expect(result.order.some((id) => id.startsWith('alone'))).toBe(false);
    });

    it('moves on to the next nearest once a chain is satisfied', () => {
      const { doc, ids } = chainIntoNear();
      const result = schedule(doc, { visible: ids, concurrencyLimit: 9, viewport: VIEWPORT });
      expect(result.order.length).toBe(9);
      expect(result.order).toContain('near');
      // Seven for the chain and `near`, then the two nearest independents.
      expect(result.order).toContain('alone0');
      expect(result.order).toContain('alone1');
      expect(result.order).not.toContain('alone2');
    });
  });

  // A row of tiles or a grid of cells puts many nodes at the same distance, and
  // a batch that varied between identical frames would make every downstream
  // measurement unreproducible.
  it('is deterministic when distances tie', () => {
    const doc = createDocument('tie');
    const ids: NodeID[] = [];
    for (let i = 0; i < 20; i += 1) {
      const id = `t${i}`;
      ids.push(id);
      // All at the same distance: a ring around the viewport.
      addNode(doc, node({ id, binding: 'wired', x: 5_000, y: i * 0, w: 200, h: 100 })).state = { status: 'stale' };
    }
    const once = schedule(doc, { visible: ids, concurrencyLimit: 6, viewport: VIEWPORT });
    const twice = schedule(doc, { visible: ids, concurrencyLimit: 6, viewport: VIEWPORT });
    expect(once.order).toEqual(twice.order);
    expect(once.order.length).toBe(6);
  });
});
