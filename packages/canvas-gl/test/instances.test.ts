import { describe, expect, it } from 'vitest';
import {
  CanvasIndex,
  addNode,
  createDocument,
  createNode,
  type CanvasDocument,
  type Edge,
  type Viewport,
} from '@picasso/canvas-core';
import { buildScene, lightTheme } from '@picasso/canvas-render';
import {
  EDGE_STRIDE,
  NODE_STRIDE,
  ensureCapacity,
  packEdges,
  packNodes,
  packScene,
  parseColor,
} from '../src/instances.js';

function vp(over: Partial<Viewport> = {}): Viewport {
  return { x: 0, y: 0, scale: 1, width: 1200, height: 800, ...over };
}

function docOf(count: number, spread = 260): CanvasDocument {
  const doc = createDocument('gl');
  const perRow = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    addNode(
      doc,
      createNode({
        id: `n${i}`,
        kind: 'DataTile',
        binding: i % 5 === 0 ? 'loose' : 'wired',
        position: { x: (i % perRow) * spread, y: Math.floor(i / perRow) * spread },
        size: { w: 200, h: 140 },
        outputs: [{ id: 'out', name: 'out', type: 'series', cardinality: 'many', required: false }],
        inputs: [{ id: 'in', name: 'in', type: 'series', cardinality: 'many', required: false }],
      }),
    );
  }
  return doc;
}

describe('color parsing', () => {
  it('handles the forms the theme uses', () => {
    expect(parseColor('#ffffff')).toEqual([1, 1, 1, 1]);
    expect(parseColor('#000000')).toEqual([0, 0, 0, 1]);
    expect(parseColor('#f00')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#ff000080')[3]).toBeCloseTo(128 / 255, 6);
    const grey = parseColor('#808080');
    expect(grey[0]).toBeCloseTo(128 / 255, 6);
  });

  it('handles rgb and rgba', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual([1, 0, 0, 1]);
    expect(parseColor('rgba(0, 255, 0, 0.5)')).toEqual([0, 1, 0, 0.5]);
  });

  it('falls back rather than throwing inside a render loop', () => {
    // A wrong colour for one frame is recoverable; an exception is not.
    expect(() => parseColor('chartreuse')).not.toThrow();
    expect(parseColor('#12345')).toEqual([1, 0, 1, 1]);
    expect(parseColor('')).toEqual([1, 0, 1, 1]);
  });

  it('caches, since the same handful of colours repeat every frame', () => {
    expect(parseColor('#123456')).toBe(parseColor('#123456'));
  });
});

describe('node packing', () => {
  it('writes the documented layout', () => {
    // An explicitly wired node: the shared fixture makes every fifth one loose,
    // and a loose node is drawn on paper rather than on surface.
    const doc = createDocument('layout');
    addNode(
      doc,
      createNode({
        id: 'wired',
        kind: 'DataTile',
        binding: 'wired',
        position: { x: 0, y: 0 },
        size: { w: 200, h: 140 },
      }),
    );
    const index = new CanvasIndex(doc);
    const scene = buildScene({ doc, index, viewport: vp(), theme: lightTheme });
    const packed = packNodes(scene.dom);

    expect(packed.count).toBe(1);
    expect(packed.stride).toBe(NODE_STRIDE);
    // rect: x, y, w, h in screen pixels.
    expect([...packed.data.slice(0, 4)]).toEqual([0, 0, 200, 140]);
    // The fill is the theme's surface colour for a wired node.
    expect([...packed.data.slice(4, 8)]).toEqual([...parseColor(lightTheme.surface)]);
  });

  it('folds node opacity into every colour, so a frozen card is uniformly faded', () => {
    const doc = createDocument('c');
    const node = createNode({
      id: 'frozen',
      kind: 'ChartNode',
      binding: 'loose',
      position: { x: 0, y: 0 },
      size: { w: 100, h: 100 },
    });
    node.frozen = { values: {}, asof: '', frozenAt: 0, previousBinding: 'wired' };
    addNode(doc, node);

    const scene = buildScene({
      doc,
      index: new CanvasIndex(doc),
      viewport: vp(),
      theme: lightTheme,
    });
    const opacity = scene.dom[0]?.style.opacity as number;
    expect(opacity).toBeLessThan(1);

    const packed = packNodes(scene.dom);
    expect(packed.data[7]).toBeCloseTo(opacity, 6);   // fill alpha
    expect(packed.data[11]).toBeCloseTo(opacity, 6);  // stroke alpha
    expect(packed.data[15]).toBeCloseTo(opacity, 6);  // status alpha
  });

  it('flags a soft stroke, which is how a loose object stays legible at LOD0', () => {
    const doc = docOf(2);
    const scene = buildScene({
      doc,
      index: new CanvasIndex(doc),
      viewport: vp({ scale: 0.1 }),
      theme: lightTheme,
    });
    const looseIndex = scene.quads.findIndex((n) => n.binding === 'loose');
    const wiredIndex = scene.quads.findIndex((n) => n.binding === 'wired');
    expect(looseIndex).toBeGreaterThanOrEqual(0);

    const packed = packNodes(scene.quads);
    expect(packed.data[looseIndex * NODE_STRIDE + 18]).toBe(1);
    expect(packed.data[wiredIndex * NODE_STRIDE + 18]).toBe(0);
  });

  it('carries the passive-mode wash through', () => {
    const doc = docOf(1);
    const scene = buildScene({ doc, index: new CanvasIndex(doc), viewport: vp(), theme: lightTheme });
    const node = scene.dom[0];
    if (!node) throw new Error('missing');
    node.wash = 0.8;
    expect(packNodes([node]).data[19]).toBeCloseTo(0.8, 6);
  });

  it('writes into a caller-supplied buffer without reallocating', () => {
    const doc = docOf(4);
    const scene = buildScene({ doc, index: new CanvasIndex(doc), viewport: vp(), theme: lightTheme });
    const scratch = new Float32Array(64 * NODE_STRIDE);
    const packed = packNodes(scene.dom, scratch);
    expect(packed.data).toBe(scratch);
    expect(packed.count).toBe(scene.dom.length);
  });

  it('packs nothing gracefully', () => {
    const packed = packNodes([]);
    expect(packed.count).toBe(0);
    expect(packed.data.length).toBeGreaterThan(0);
  });
});

describe('edge packing', () => {
  it('writes control points and style', () => {
    const doc = docOf(2, 300);
    const edge: Edge = {
      id: 'e1',
      from: { nodeId: 'n0', portId: 'out' },
      to: { nodeId: 'n1', portId: 'in' },
      class: 'reference',
    };
    doc.edges.set(edge.id, edge);

    const scene = buildScene({ doc, index: new CanvasIndex(doc), viewport: vp(), theme: lightTheme });
    const packed = packEdges(scene.edges);
    const sceneEdge = scene.edges[0];
    if (!sceneEdge) throw new Error('missing');

    expect(packed.count).toBe(1);
    expect(packed.stride).toBe(EDGE_STRIDE);
    expect(packed.data[0]).toBeCloseTo(sceneEdge.screen.p0.x, 5);
    expect(packed.data[3]).toBeCloseTo(sceneEdge.screen.c.y, 5);
    expect(packed.data[5]).toBeCloseTo(sceneEdge.screen.p1.y, 5);
    // A reference edge is dotted and faint until hover.
    expect(packed.data[11]).toBe(1);
    expect(packed.data[9]).toBeCloseTo(sceneEdge.style.opacity, 5);
  });
});

describe('one batch, whatever the LOD', () => {
  it('packs quads, tiles and DOM nodes into a single buffer', () => {
    const doc = docOf(400, 300);
    const index = new CanvasIndex(doc);

    for (const scale of [0.08, 0.3, 0.75]) {
      const scene = buildScene({ doc, index, viewport: vp({ scale }), theme: lightTheme });
      const drawn = scene.quads.length + scene.tiles.length + scene.dom.length;
      const packed = packScene(scene);
      expect(packed.nodes.count).toBe(drawn);
      expect(drawn).toBeGreaterThan(0);
    }
  });
});

describe('packing cost', () => {
  it('packs 5,000 on-screen nodes inside a fraction of the frame budget', () => {
    // The Phase 0 target is 5,000 nodes at 60fps. Everything visible at once is
    // the worst case: no culling, every node an instance.
    const doc = docOf(5_000, 22);
    const index = new CanvasIndex(doc);
    const scene = buildScene({ doc, index, viewport: vp({ scale: 0.06 }), theme: lightTheme });
    expect(scene.quads.length).toBe(5_000);

    const scratch = new Float32Array(5_000 * NODE_STRIDE);
    for (let i = 0; i < 5; i++) packNodes(scene.quads, scratch);

    const started = performance.now();
    const runs = 20;
    for (let i = 0; i < runs; i++) packNodes(scene.quads, scratch);
    const perFrame = (performance.now() - started) / runs;

    // The frame budget is 16ms for everything; packing gets a slice of it.
    expect(perFrame).toBeLessThan(3);
  });

  it('reuses its buffer, so a steady-state frame allocates nothing', () => {
    let buffer = ensureCapacity(undefined, 10, NODE_STRIDE);
    const first = buffer;
    buffer = ensureCapacity(buffer, 20, NODE_STRIDE);
    // Already big enough: the same array comes back.
    expect(buffer).toBe(first);

    const grown = ensureCapacity(buffer, 10_000, NODE_STRIDE);
    expect(grown).not.toBe(first);
    expect(grown.length).toBeGreaterThanOrEqual(10_000 * NODE_STRIDE);
    // Growing doubles rather than fitting exactly, so it settles quickly.
    expect(ensureCapacity(grown, 10_001, NODE_STRIDE)).toBe(grown);
  });
});
