import { describe, expect, it } from 'vitest';
import {
  CanvasIndex,
  addNode,
  connect,
  createDocument,
  createNode,
  disconnect,
  inputPorts,
  moveNode,
  nodeRect,
  outputPorts,
  removeNode,
  resizeNode,
} from '../src/document.js';
import { visibleWorldRect, type Viewport } from '../src/viewport.js';
import { node, port } from './fixtures.js';

describe('document', () => {
  it('gives a new object the defaults of a sketch: loose and idle', () => {
    const n = createNode({ id: 'x', kind: 'InkLayer' });
    expect(n.binding).toBe('loose');
    expect(n.state.status).toBe('idle');
    expect(n.provenance.verified).toBe(true);
    expect(n.createdBy).toBe('user');
  });

  it('hides ports on anything that is not wired', () => {
    const wired = node({ inputs: [port('in', 'series')], outputs: [port('out', 'series')] });
    expect(inputPorts(wired)).toHaveLength(1);
    expect(outputPorts(wired)).toHaveLength(1);

    wired.binding = 'bound';
    expect(inputPorts(wired)).toHaveLength(0);
    expect(outputPorts(wired)).toHaveLength(0);
  });

  it('connects a valid wire, stamps the adapter and invalidates downstream', () => {
    const doc = createDocument('c');
    addNode(doc, node({ id: 'a', outputs: [port('out', 'series')] }));
    addNode(
      doc,
      node({ id: 'b', inputs: [port('in', 'scalar')], outputs: [port('out', 'scalar')] }),
    );
    addNode(doc, node({ id: 'c', inputs: [port('in', 'scalar')] }));
    doc.edges.set('e0', {
      id: 'e0',
      from: { nodeId: 'b', portId: 'out' },
      to: { nodeId: 'c', portId: 'in' },
      class: 'data',
    });

    const result = connect(doc, {
      id: 'e1',
      from: { nodeId: 'a', portId: 'out' },
      to: { nodeId: 'b', portId: 'in' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.edge.adapter).toBe('latest');
    // b changed, so c is stale too.
    expect(result.invalidated).toEqual(new Set(['b', 'c']));
    expect(doc.nodes.get('c')?.state.status).toBe('stale');
  });

  it('adds nothing when the wire is refused', () => {
    const doc = createDocument('c');
    addNode(doc, node({ id: 'a', outputs: [port('out', 'scalar')] }));
    addNode(doc, node({ id: 'b', inputs: [port('in', 'series')] }));

    const result = connect(doc, {
      id: 'e1',
      from: { nodeId: 'a', portId: 'out' },
      to: { nodeId: 'b', portId: 'in' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rejection.code).toBe('type_mismatch');
    expect(doc.edges.size).toBe(0);
  });

  it('refuses a wire that would close a cycle', () => {
    const doc = createDocument('c');
    for (const id of ['a', 'b']) {
      addNode(
        doc,
        node({ id, inputs: [port('in', 'series')], outputs: [port('out', 'series')] }),
      );
    }
    connect(doc, { id: 'e1', from: { nodeId: 'a', portId: 'out' }, to: { nodeId: 'b', portId: 'in' } });
    const back = connect(doc, {
      id: 'e2',
      from: { nodeId: 'b', portId: 'out' },
      to: { nodeId: 'a', portId: 'in' },
    });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.rejection.code).toBe('cycle');
  });

  it('disconnecting and deleting both invalidate what they fed', () => {
    const doc = createDocument('c');
    addNode(doc, node({ id: 'a', outputs: [port('out', 'series')] }));
    addNode(doc, node({ id: 'b', inputs: [port('in', 'series')] }));
    connect(doc, { id: 'e1', from: { nodeId: 'a', portId: 'out' }, to: { nodeId: 'b', portId: 'in' } });

    const b = doc.nodes.get('b');
    if (!b) throw new Error('missing');
    b.state = { status: 'ready', cacheKey: 'k' };
    disconnect(doc, 'e1');
    expect(doc.edges.size).toBe(0);
    expect(b.state.status).toBe('stale');

    connect(doc, { id: 'e2', from: { nodeId: 'a', portId: 'out' }, to: { nodeId: 'b', portId: 'in' } });
    b.state = { status: 'ready', cacheKey: 'k' };
    const removed = removeNode(doc, 'a');
    expect(removed).toHaveLength(1);
    expect(doc.nodes.has('a')).toBe(false);
    expect(b.state.status).toBe('stale');
  });
});

describe('CanvasIndex', () => {
  const vp: Viewport = { x: 0, y: 0, scale: 1, width: 1000, height: 800 };

  it('returns what the viewport plus margin covers, and drops what it does not', () => {
    const doc = createDocument('c');
    const inside = addNode(doc, node({ id: 'in', x: 100, y: 100, w: 200, h: 150 }));
    const nearby = addNode(doc, node({ id: 'near', x: 1200, y: 100, w: 200, h: 150 }));
    addNode(doc, node({ id: 'far', x: 50_000, y: 50_000, w: 200, h: 150 }));

    const index = new CanvasIndex(doc);
    expect(index.size).toBe(3);

    const visible = new Set(index.visible(vp));
    // The margin is 1.5 screens, so `near` is prefetched and `far` is not.
    expect(visible.has(inside.id)).toBe(true);
    expect(visible.has(nearby.id)).toBe(true);
    expect(visible.has('far')).toBe(false);

    // Strictly on screen is a tighter query.
    expect(new Set(index.query(visibleWorldRect(vp)))).toEqual(new Set([inside.id]));
  });

  it('tracks moves and resizes incrementally', () => {
    const doc = createDocument('c');
    addNode(doc, node({ id: 'a', x: 0, y: 0, w: 100, h: 100 }));
    const index = new CanvasIndex(doc);

    moveNode(doc, index, 'a', { x: 5_000, y: 5_000 });
    expect(index.query({ minX: 0, minY: 0, maxX: 200, maxY: 200 })).toEqual([]);
    expect(index.query({ minX: 4_900, minY: 4_900, maxX: 5_200, maxY: 5_200 })).toEqual(['a']);

    resizeNode(doc, index, 'a', { w: 2_000, h: 2_000 });
    const a = doc.nodes.get('a');
    if (!a) throw new Error('missing');
    expect(nodeRect(a)).toEqual({ minX: 5_000, minY: 5_000, maxX: 7_000, maxY: 7_000 });
    expect(index.query({ minX: 6_500, minY: 6_500, maxX: 6_600, maxY: 6_600 })).toEqual(['a']);

    index.remove('a');
    expect(index.size).toBe(0);
  });

  it('hit-tests the topmost node under a point', () => {
    const doc = createDocument('c');
    const under = addNode(doc, node({ id: 'under', x: 0, y: 0, w: 100, h: 100 }));
    const over = addNode(doc, node({ id: 'over', x: 50, y: 50, w: 100, h: 100 }));
    under.z = 0;
    over.z = 1;
    const index = new CanvasIndex(doc);

    expect(index.hit(doc, { x: 60, y: 60 })?.id).toBe('over');
    expect(index.hit(doc, { x: 10, y: 10 })?.id).toBe('under');
    expect(index.hit(doc, { x: 900, y: 900 })).toBeUndefined();
  });

  it('indexes loose objects alongside wired ones: one document, one index', () => {
    const doc = createDocument('c');
    addNode(doc, node({ id: 'ink', binding: 'loose', kind: 'InkLayer', x: 10, y: 10, w: 50, h: 50 }));
    addNode(doc, node({ id: 'chart', binding: 'wired', x: 20, y: 20, w: 50, h: 50 }));
    const index = new CanvasIndex(doc);
    expect(new Set(index.query({ minX: 0, minY: 0, maxX: 100, maxY: 100 }))).toEqual(
      new Set(['ink', 'chart']),
    );
  });
});
