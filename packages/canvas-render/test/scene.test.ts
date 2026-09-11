import { describe, expect, it } from 'vitest';
import {
  CanvasIndex,
  addNode,
  createDocument,
  createNode,
  type CanvasDocument,
  type Edge,
  type NodeKind,
  type Viewport,
} from '@picasso/canvas-core';
import { buildScene, glyphFor, onScreenNodes, titleFor } from '../src/scene.js';
import { WashLayer } from '../src/wash.js';
import { lightTheme } from '../src/theme.js';

function vp(over: Partial<Viewport> = {}): Viewport {
  return { x: 0, y: 0, scale: 1, width: 1000, height: 800, ...over };
}

function docWith(
  specs: Array<{ id: string; x: number; y: number; kind?: NodeKind; binding?: 'loose' | 'bound' | 'wired' }>,
): CanvasDocument {
  const doc = createDocument('c');
  for (const spec of specs) {
    addNode(
      doc,
      createNode({
        id: spec.id,
        kind: spec.kind ?? 'ChartNode',
        binding: spec.binding ?? 'wired',
        position: { x: spec.x, y: spec.y },
        size: { w: 200, h: 140 },
        outputs: [{ id: 'out', name: 'out', type: 'series', cardinality: 'one', required: false }],
        inputs: [{ id: 'in', name: 'in', type: 'series', cardinality: 'one', required: false }],
      }),
    );
  }
  return doc;
}

function wire(doc: CanvasDocument, from: string, to: string, over: Partial<Edge> = {}): void {
  const edge: Edge = {
    id: `${from}->${to}`,
    from: { nodeId: from, portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    class: 'data',
    ...over,
  };
  doc.edges.set(edge.id, edge);
}

describe('scene assembly', () => {
  it('buckets nodes by LOD and reports what it culled', () => {
    const doc = docWith([
      { id: 'near', x: 100, y: 100 },
      { id: 'far', x: 90_000, y: 90_000 },
    ]);
    const index = new CanvasIndex(doc);

    const lod2 = buildScene({ doc, index, viewport: vp({ scale: 1 }), theme: lightTheme });
    expect(lod2.lod).toBe(2);
    expect(lod2.dom.map((n) => n.id)).toEqual(['near']);
    expect(lod2.quads).toEqual([]);
    expect(lod2.stats).toMatchObject({ nodesTotal: 2, nodesDrawn: 1, nodesCulled: 1 });

    const lod0 = buildScene({ doc, index, viewport: vp({ scale: 0.05 }), theme: lightTheme });
    expect(lod0.lod).toBe(0);
    expect(lod0.dom).toEqual([]);
    // The cull rect grows with the zoom-out, but 90k world units away is still
    // far outside it at this scale.
    expect(lod0.quads.map((n) => n.id)).toEqual(['near']);

    // Zoomed out far enough that the whole canvas fits, both are quads.
    const wide = buildScene({ doc, index, viewport: vp({ scale: 0.001 }), theme: lightTheme });
    expect(wide.lod).toBe(0);
    expect(new Set(wide.quads.map((n) => n.id))).toEqual(new Set(['near', 'far']));

    const lod1 = buildScene({ doc, index, viewport: vp({ scale: 0.3 }), theme: lightTheme });
    expect(lod1.tiles.map((n) => n.id)).toEqual(['near']);
  });

  it('projects world rects into screen space through the viewport', () => {
    const doc = docWith([{ id: 'a', x: 100, y: 50 }]);
    const index = new CanvasIndex(doc);
    const scene = buildScene({
      doc,
      index,
      viewport: vp({ x: 50, y: 25, scale: 2 }),
      theme: lightTheme,
    });
    expect(scene.dom[0]?.screenRect).toEqual({
      minX: 100,
      minY: 50,
      maxX: 500,
      maxY: 330,
    });
  });

  it('draws loose objects alongside wired ones, with their own signature', () => {
    const doc = docWith([
      { id: 'ink', x: 0, y: 0, kind: 'InkLayer', binding: 'loose' },
      { id: 'chart', x: 300, y: 0, binding: 'wired' },
    ]);
    const index = new CanvasIndex(doc);
    const scene = buildScene({ doc, index, viewport: vp(), theme: lightTheme });

    const ink = scene.dom.find((n) => n.id === 'ink');
    const chart = scene.dom.find((n) => n.id === 'chart');
    expect(ink?.style.fill).toBe(lightTheme.paper);
    expect(ink?.style.showPortDots).toBe(false);
    expect(chart?.style.showPortDots).toBe(true);
    expect(ink?.glyph).toBe(glyphFor('InkLayer'));
  });

  it('keeps an edge whose endpoints are both off screen but whose curve crosses it', () => {
    const doc = docWith([
      { id: 'left', x: -6_000, y: 300 },
      { id: 'right', x: 6_000, y: 300 },
    ]);
    wire(doc, 'left', 'right');
    const index = new CanvasIndex(doc);

    const scene = buildScene({ doc, index, viewport: vp(), theme: lightTheme });
    expect(scene.dom).toHaveLength(0);
    expect(scene.edges).toHaveLength(1);
    expect(scene.stats.edgesDrawn).toBe(1);
  });

  it('culls an edge nowhere near the viewport', () => {
    const doc = docWith([
      { id: 'a', x: 80_000, y: 80_000 },
      { id: 'b', x: 80_500, y: 80_000 },
    ]);
    wire(doc, 'a', 'b');
    const index = new CanvasIndex(doc);
    expect(buildScene({ doc, index, viewport: vp(), theme: lightTheme }).edges).toEqual([]);
  });

  it('pulses a data edge only while its target is computing', () => {
    const doc = docWith([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 400, y: 0 },
    ]);
    wire(doc, 'a', 'b');
    const index = new CanvasIndex(doc);
    expect(buildScene({ doc, index, viewport: vp(), theme: lightTheme }).edges[0]?.style.pulse)
      .toBe(false);

    const b = doc.nodes.get('b');
    if (!b) throw new Error('missing');
    b.state = { status: 'computing' };
    expect(buildScene({ doc, index, viewport: vp(), theme: lightTheme }).edges[0]?.style.pulse)
      .toBe(true);
  });

  it('strips edge decoration when the whole canvas is zoomed out', () => {
    const doc = docWith([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 400, y: 0 },
    ]);
    wire(doc, 'a', 'b', {
      class: 'causal',
      causal: { sign: -1, elasticity: 2, lagPeriods: 3 },
    });
    const index = new CanvasIndex(doc);

    const close = buildScene({ doc, index, viewport: vp(), theme: lightTheme });
    expect(close.edges[0]?.style.label).toBe('t+3');

    const far = buildScene({ doc, index, viewport: vp({ scale: 0.1 }), theme: lightTheme });
    expect(far.edges[0]?.style.label).toBeUndefined();
    expect(far.edges[0]?.style.arrowhead).toBe(false);
  });

  it('drops an edge whose endpoint node was deleted', () => {
    const doc = docWith([{ id: 'a', x: 0, y: 0 }]);
    wire(doc, 'a', 'ghost');
    const index = new CanvasIndex(doc);
    expect(buildScene({ doc, index, viewport: vp(), theme: lightTheme }).edges).toEqual([]);
  });

  it('paints the passive-mode wash and halo on nodes that moved', () => {
    const doc = docWith([
      { id: 'hot', x: 0, y: 0 },
      { id: 'quiet', x: 400, y: 0 },
    ]);
    const index = new CanvasIndex(doc);
    const wash = new WashLayer();
    wash.bump('hot', 7, 0);

    const scene = buildScene({ doc, index, viewport: vp(), theme: lightTheme, wash, now: 0 });
    const hot = scene.dom.find((n) => n.id === 'hot');
    const quiet = scene.dom.find((n) => n.id === 'quiet');
    expect(hot?.wash).toBeGreaterThan(0);
    expect(hot?.halo?.severity).toBe('high');
    expect(quiet?.wash).toBeUndefined();
    expect(quiet?.halo).toBeUndefined();
  });

  it('marks the selection', () => {
    const doc = docWith([{ id: 'a', x: 0, y: 0 }]);
    const index = new CanvasIndex(doc);
    const scene = buildScene({
      doc,
      index,
      viewport: vp(),
      theme: lightTheme,
      selection: new Set(['a']),
    });
    expect(scene.dom[0]?.selected).toBe(true);
  });

  it('names a node by its label, then its ticker, then its kind', () => {
    const labelled = createNode({ id: 'x', kind: 'ChartNode', params: { label: 'Semis basket' } });
    const tickered = createNode({ id: 'y', kind: 'DataTile', params: { ticker: 'NVDA' } });
    const bare = createNode({ id: 'z', kind: 'BacktestNode' });
    expect(titleFor(labelled)).toBe('Semis basket');
    expect(titleFor(tickered)).toBe('NVDA');
    expect(titleFor(bare)).toBe('BacktestNode');
  });

  it('gives every node kind a distinct glyph', () => {
    const kinds: NodeKind[] = [
      'DataTile', 'ChartNode', 'TableNode', 'SurfaceNode', 'CurveNode', 'UniverseNode',
      'HeatmapNode', 'TransformNode', 'CodeNode', 'MonteCarloNode', 'BacktestNode',
      'OptimizerNode', 'FactorNode', 'ScenarioNode', 'CausalNode', 'ScoringNode',
      'StrategyNode', 'ChainMetricNode', 'ProbabilityCurveNode', 'HypothesisNode',
      'QueryNode', 'AgentNode', 'TextPad', 'InkLayer', 'EvidenceNode', 'FrameNode',
    ];
    const glyphs = kinds.map(glyphFor);
    expect(new Set(glyphs).size).toBe(kinds.length);
  });

  it('separates the on-screen set from the prefetched cull margin', () => {
    const doc = docWith([
      { id: 'on', x: 100, y: 100 },
      { id: 'margin', x: 1_400, y: 100 },
    ]);
    const index = new CanvasIndex(doc);
    expect(onScreenNodes(index, vp())).toEqual(['on']);
    // The margin node is still drawn, because it is one pan away.
    expect(buildScene({ doc, index, viewport: vp(), theme: lightTheme }).dom).toHaveLength(2);
  });
});

describe('scene assembly cost', () => {
  it('tracks what is on screen, not what is on the canvas', () => {
    const doc = createDocument('big');
    for (let i = 0; i < 10_000; i++) {
      addNode(
        doc,
        createNode({
          id: `n${i}`,
          kind: 'DataTile',
          binding: 'wired',
          position: { x: (i % 100) * 6_000, y: Math.floor(i / 100) * 6_000 },
          size: { w: 200, h: 140 },
        }),
      );
    }
    const index = new CanvasIndex(doc);
    const viewport = vp();

    // Warm up, then measure a steady-state frame.
    for (let i = 0; i < 5; i++) buildScene({ doc, index, viewport, theme: lightTheme });
    const scene = buildScene({ doc, index, viewport, theme: lightTheme });

    expect(scene.stats.nodesTotal).toBe(10_000);
    expect(scene.stats.nodesDrawn).toBeLessThan(20);
    // The frame budget is 16ms for everything; assembly gets a fraction of it.
    expect(scene.stats.buildMs).toBeLessThan(4);
  });
});
