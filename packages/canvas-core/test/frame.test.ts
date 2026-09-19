import { describe, expect, it } from 'vitest';
import {
  EmptyFrame,
  FRAME_HEADER,
  FRAME_PADDING,
  FrameWouldNest,
  collapseView,
  descendantsOf,
  frameRect,
  frameSelection,
  isCollapsed,
  membersOf,
  setCollapsed,
} from '../src/frame.js';
import { addNode, createDocument } from '../src/document.js';
import type { CanvasDocument, Edge } from '../src/types.js';
import { node } from './fixtures.js';

function wire(doc: CanvasDocument, from: string, to: string): Edge {
  const edge: Edge = {
    id: `${from}->${to}`,
    from: { nodeId: from, portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    class: 'data',
  };
  doc.edges.set(edge.id, edge);
  return edge;
}

/** Three nodes in a row, with one outside feeding in and one reading out. */
function canvas(): CanvasDocument {
  const doc = createDocument('c');
  const layers: Record<string, number> = { source: 1, a: 5, b: 3, c: 7, reader: 2 };
  addNode(doc, node({ id: 'source', x: -400, y: 100, w: 200, h: 100 }));
  addNode(doc, node({ id: 'a', x: 0, y: 0, w: 200, h: 100 }));
  addNode(doc, node({ id: 'b', x: 300, y: 50, w: 200, h: 100 }));
  addNode(doc, node({ id: 'c', x: 150, y: 250, w: 200, h: 100 }));
  addNode(doc, node({ id: 'reader', x: 900, y: 100, w: 200, h: 100 }));
  // Stacking order, which `frameSelection` has to sit below.
  for (const [id, z] of Object.entries(layers)) doc.nodes.get(id)!.z = z;
  wire(doc, 'source', 'a');
  wire(doc, 'a', 'b');
  wire(doc, 'b', 'c');
  wire(doc, 'c', 'reader');
  return doc;
}

describe('framing a selection', () => {
  it('fits around what was selected, with room for the title bar', () => {
    const doc = canvas();
    const frame = frameSelection(doc, ['a', 'b', 'c'], { id: 'f1', title: 'the chain' });

    // Members span x 0..500 and y 0..350.
    expect(frame.position.x).toBe(0 - FRAME_PADDING);
    expect(frame.position.y).toBe(0 - FRAME_PADDING - FRAME_HEADER);
    expect(frame.size.w).toBe(500 + FRAME_PADDING * 2);
    expect(frame.size.h).toBe(350 + FRAME_PADDING * 2 + FRAME_HEADER);
    expect(frame.params.title).toBe('the chain');
    expect(frame.kind).toBe('FrameNode');
  });

  // The layout is part of the analysis. An operation that tidied it would be
  // an edit nobody asked for.
  it('moves nothing', () => {
    const doc = canvas();
    const before = ['a', 'b', 'c'].map((id) => ({ ...doc.nodes.get(id)!.position }));
    frameSelection(doc, ['a', 'b', 'c'], { id: 'f1' });
    const after = ['a', 'b', 'c'].map((id) => ({ ...doc.nodes.get(id)!.position }));
    expect(after).toEqual(before);
  });

  it('sits behind its members so it does not cover them', () => {
    const doc = canvas();
    const frame = frameSelection(doc, ['a', 'b', 'c'], { id: 'f1' });
    for (const id of ['a', 'b', 'c']) {
      expect(frame.z).toBeLessThan(doc.nodes.get(id)!.z);
    }
  });

  it('claims its members and only its members', () => {
    const doc = canvas();
    frameSelection(doc, ['a', 'b'], { id: 'f1' });
    expect(membersOf(doc, 'f1')).toEqual(['a', 'b']);
    expect(doc.nodes.get('c')?.parentFrame).toBeUndefined();
    expect(doc.nodes.get('source')?.parentFrame).toBeUndefined();
  });

  it('carries a sketch mode through, which suppresses promotion inside it', () => {
    const doc = canvas();
    const frame = frameSelection(doc, ['a'], { id: 'f1', mode: 'sketch' });
    expect(frame.frameMode).toBe('sketch');
    const plain = frameSelection(doc, ['b'], { id: 'f2' });
    expect(plain.frameMode).toBeUndefined();
  });

  it('computes nothing, so it is idle rather than stale', () => {
    const doc = canvas();
    const frame = frameSelection(doc, ['a'], { id: 'f1' });
    expect(frame.binding).toBe('loose');
    expect(frame.state.status).toBe('idle');
  });

  // A node has one owner. Quietly re-parenting it is an edit nobody asked for.
  it('refuses a node that is already in a frame', () => {
    const doc = canvas();
    frameSelection(doc, ['a', 'b'], { id: 'f1' });
    expect(() => frameSelection(doc, ['b', 'c'], { id: 'f2' })).toThrow(FrameWouldNest);
    // And nothing was half-done.
    expect(doc.nodes.has('f2')).toBe(false);
    expect(doc.nodes.get('c')?.parentFrame).toBeUndefined();
  });

  it('refuses an empty selection, and ignores ids that are not there', () => {
    const doc = canvas();
    expect(() => frameSelection(doc, [], { id: 'f1' })).toThrow(EmptyFrame);
    expect(() => frameSelection(doc, ['ghost'], { id: 'f1' })).toThrow(EmptyFrame);
    const frame = frameSelection(doc, ['a', 'ghost'], { id: 'f1' });
    expect(membersOf(doc, 'f1')).toEqual(['a']);
    expect(frameRect(frame).minX).toBe(-FRAME_PADDING);
  });
});

describe('collapsing a frame', () => {
  it('starts expanded and folds on request', () => {
    const doc = canvas();
    const frame = frameSelection(doc, ['a', 'b', 'c'], { id: 'f1' });
    expect(isCollapsed(frame)).toBe(false);

    setCollapsed(doc, 'f1', true);
    expect(isCollapsed(doc.nodes.get('f1')!)).toBe(true);
    setCollapsed(doc, 'f1', false);
    expect(isCollapsed(doc.nodes.get('f1')!)).toBe(false);
  });

  // Collapse is a view operation. An analyst who folds away the nodes that
  // produced a number still wants the number, and unfolding must not recompute.
  it('does not invalidate anything', () => {
    const doc = canvas();
    frameSelection(doc, ['a', 'b', 'c'], { id: 'f1' });
    for (const id of ['a', 'b', 'c']) {
      const n = doc.nodes.get(id)!;
      n.binding = 'wired';
      n.state = { status: 'ready', cacheKey: `ck-${id}` };
    }

    setCollapsed(doc, 'f1', true);
    for (const id of ['a', 'b', 'c']) {
      expect(doc.nodes.get(id)?.state.status, id).toBe('ready');
      expect(doc.nodes.get(id)?.state.cacheKey, id).toBe(`ck-${id}`);
    }
  });

  it('hides its members from the scene', () => {
    const doc = canvas();
    frameSelection(doc, ['a', 'b', 'c'], { id: 'f1' });
    setCollapsed(doc, 'f1', true);

    const view = collapseView(doc);
    expect(view.hidden).toEqual(new Set(['a', 'b', 'c']));
    expect(view.hidden.has('source')).toBe(false);
    expect(view.hidden.has('reader')).toBe(false);
  });

  // The interesting case: an edge from outside into a folded frame still
  // carries data, and hiding it would remove the only sign the frame is wired
  // into anything.
  it('re-attaches edges that cross the boundary, and hides the ones inside', () => {
    const doc = canvas();
    frameSelection(doc, ['a', 'b', 'c'], { id: 'f1' });
    setCollapsed(doc, 'f1', true);

    const { crossings } = collapseView(doc);
    const ids = crossings.map((c) => c.edge.id).sort();
    expect(ids).toEqual(['c->reader', 'source->a']);

    const inbound = crossings.find((c) => c.edge.id === 'source->a')!;
    expect(inbound.hiddenEnd).toBe('to');
    expect(inbound.frameId).toBe('f1');

    const outbound = crossings.find((c) => c.edge.id === 'c->reader')!;
    expect(outbound.hiddenEnd).toBe('from');
    expect(outbound.frameId).toBe('f1');
  });

  it('hides an edge whose two ends are both inside', () => {
    const doc = canvas();
    frameSelection(doc, ['a', 'b', 'c'], { id: 'f1' });
    setCollapsed(doc, 'f1', true);
    const { crossings } = collapseView(doc);
    expect(crossings.map((c) => c.edge.id)).not.toContain('a->b');
    expect(crossings.map((c) => c.edge.id)).not.toContain('b->c');
  });

  it('hides nothing while every frame is open', () => {
    const doc = canvas();
    frameSelection(doc, ['a', 'b', 'c'], { id: 'f1' });
    const view = collapseView(doc);
    expect(view.hidden.size).toBe(0);
    expect(view.crossings).toEqual([]);
  });

  // `frameSelection` refuses to nest, but a peer's edit can arrive over sync
  // with a frame inside a frame, and a collapse that only hid direct members
  // would leave the inner contents on screen with nothing around them.
  it('hides nested frames to any depth', () => {
    const doc = canvas();
    frameSelection(doc, ['a', 'b'], { id: 'inner' });
    // Nest by hand, the way a merge could.
    doc.nodes.get('inner')!.parentFrame = 'outer';
    addNode(doc, node({ id: 'outer', kind: 'FrameNode', x: -50, y: -50, w: 900, h: 600 }));
    doc.nodes.get('outer')!.params = { title: 'outer', collapsed: false };
    doc.nodes.get('c')!.parentFrame = 'outer';

    expect(descendantsOf(doc, 'outer')).toEqual(new Set(['inner', 'a', 'b', 'c']));

    setCollapsed(doc, 'outer', true);
    const view = collapseView(doc);
    expect(view.hidden).toEqual(new Set(['inner', 'a', 'b', 'c']));
    // And an edge crossing in attaches to the frame the analyst can see.
    const inbound = view.crossings.find((cr) => cr.edge.id === 'source->a');
    expect(inbound?.frameId).toBe('outer');
  });

  it('does nothing for an id that is not a frame', () => {
    const doc = canvas();
    setCollapsed(doc, 'a', true);
    expect(collapseView(doc).hidden.size).toBe(0);
    setCollapsed(doc, 'ghost', true);
    expect(collapseView(doc).hidden.size).toBe(0);
  });
});
