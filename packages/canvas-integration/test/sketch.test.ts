/**
 * The sketch seam: a drawn stroke becoming a node that computes.
 *
 * PRD 3.2.1: a hand-drawn box labelled "NVDA rev growth vs GM, quarterly" is
 * recognized, read, proposed, accepted, and "on accept the ink stays, greyed
 * and collapsible, linked to the node it produced". PRD 3.2: "Nothing
 * auto-promotes. Ever."
 *
 * Four packages have to agree for that to work end to end: `canvas-ink`
 * recognizes the shape and validates the model's reading, `canvas-core` holds
 * the binding states and the scheduler, `canvas-sync` carries the result to a
 * peer, and `canvas-render` has to be able to draw whatever comes out. Each
 * tests its own half; this tests that a stroke drawn at one end arrives as a
 * schedulable, renderable, synced node at the other — and that it cannot do so
 * without somebody accepting it.
 */

import { describe, expect, it } from 'vitest';
import {
  CanvasIndex,
  deriveCacheKey,
  schedule,
  type PicassoNode,
} from '@picasso/canvas-core';
import {
  RECOGNITION_FLOOR,
  ProposalNotAcceptable,
  accept,
  propose,
  recognizeShape,
  type ReferenceResolver,
} from '@picasso/canvas-ink';
import { Link, SyncedCanvas } from '@picasso/canvas-sync';
import { buildScene, lightTheme } from '@picasso/canvas-render';
import { handDrawnBox, handDrawnEllipse, mulberry32, scribble } from './strokes.js';

const resolver: ReferenceResolver = (mention, kind) => {
  if (kind === 'instrument' && mention === 'NVDA') return [{ id: 'eq:nvda:us', label: 'NVIDIA Corp' }];
  if (kind === 'metric' && mention === 'rev growth') return [{ id: 'm:revenue_growth', label: 'Revenue growth' }];
  if (kind === 'metric' && mention === 'GM') return [{ id: 'm:gross_margin', label: 'Gross margin' }];
  return [];
};

/** A hand-drawn box, through the real recognizer. */
function drawnBox(seed = 11) {
  const points = handDrawnBox(mulberry32(seed));
  const recognition = recognizeShape(points);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    recognition,
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
  };
}

function boxProposal(seed = 11) {
  const { recognition, bounds } = drawnBox(seed);
  return propose({
    shape: recognition,
    text: 'NVDA rev growth vs GM, quarterly',
    raw: { kind: 'chart', subject: 'NVDA', metrics: ['rev growth', 'GM'], frequency: 'quarterly' },
    resolve: resolver,
    strokeIds: ['s1'],
    bounds,
  });
}

describe('the recognizer feeds the semantic pass its own confidence', () => {
  it('reads a hand-drawn box as a rectangle it is sure about', () => {
    const { recognition } = drawnBox();
    expect(recognition.kind).toBe('rectangle');
    expect(recognition.confidence).toBeGreaterThan(RECOGNITION_FLOOR);
  });

  it('carries that confidence onto the proposal, not the model\'s', () => {
    const { recognition } = drawnBox();
    expect(boxProposal().confidence).toBe(recognition.confidence);
  });

  // A note asserts nothing about the world, which is what makes it the safe
  // reading for a shape nobody recognized.
  it('will not propose a chart from a scribble', () => {
    const points = scribble(mulberry32(3));
    const recognition = recognizeShape(points);
    const proposal = propose({
      shape: recognition,
      text: 'NVDA rev growth vs GM',
      raw: { kind: 'chart', subject: 'NVDA', metrics: ['rev growth'] },
      resolve: resolver,
      strokeIds: ['s1'],
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    });
    expect(proposal.acceptable).toBe(false);
    expect(() => accept(proposal, 'n1', 'maya')).toThrow(ProposalNotAcceptable);
  });
});

describe('an accepted sketch becomes a node the rest of the system can use', () => {
  function accepted(): PicassoNode {
    return accept(boxProposal(), 'chart-1', 'maya').node;
  }

  it('lands on the canvas where the ink was', () => {
    const { bounds } = drawnBox();
    const node = accepted();
    expect(node.position.x).toBeCloseTo(bounds.minX, 6);
    expect(node.size.w).toBeCloseTo(bounds.maxX - bounds.minX, 6);
  });

  // Bound, not wired: it resolves to real data and updates live, but nothing
  // is connected to it and wiring is a decision nobody has made.
  it('arrives bound, and the scheduler treats it as work', () => {
    const node = accepted();
    expect(node.binding).toBe('bound');

    const doc = { id: 'c', nodes: new Map([[node.id, node]]), edges: new Map() };
    const result = schedule(doc, { visible: [node.id] });
    expect(result.order).toEqual(['chart-1']);
  });

  it('holds enough to derive a cache key, with the resolved ids in it', () => {
    const node = accepted();
    const doc = { id: 'c', nodes: new Map([[node.id, node]]), edges: new Map() };
    const key = deriveCacheKey(doc, 'chart-1');
    expect(key).toBeDefined();

    // Change the resolved instrument and the key must move: the ids are the
    // inputs, not the handwriting they came from.
    const other: PicassoNode = { ...node, params: { ...node.params, instrument: 'eq:amd:us' } };
    const moved = deriveCacheKey(
      { id: 'c', nodes: new Map([[other.id, other]]), edges: new Map() },
      'chart-1',
    );
    expect(moved).not.toBe(key);
  });

  it('renders, with the glyph its kind carries', () => {
    const node = accepted();
    const doc = { id: 'c', nodes: new Map([[node.id, node]]), edges: new Map() };
    const scene = buildScene({
      doc,
      index: new CanvasIndex(doc),
      viewport: { x: 0, y: 0, scale: 1, width: 1200, height: 800 },
      theme: lightTheme,
    });
    // Which detail band it lands in is the viewport's business; that it is
    // drawn at all, with its kind's glyph, is the seam being tested.
    const drawn = [...scene.quads, ...scene.tiles, ...scene.dom].find((n) => n.id === 'chart-1');
    expect(drawn).toBeDefined();
    expect(drawn?.glyph).toBe('~');
    expect(scene.stats.nodesDrawn).toBe(1);
    expect(scene.stats.nodesCulled).toBe(0);
  });

  it('reaches a peer as stale, with nothing computed for them', () => {
    const maya = new SyncedCanvas({ id: 'canvas-1' });
    const sam = new SyncedCanvas({ id: 'canvas-1' });
    const link = new Link(maya.doc, sam.doc);

    maya.addNode(accepted());

    const arrived = sam.getNode('chart-1')!;
    expect(arrived.params.instrument).toBe('eq:nvda:us');
    expect(arrived.params.acceptedBy).toBe('maya');
    // The sketch's provenance travels; the computation does not.
    expect(arrived.state.status).toBe('stale');
    expect(arrived.state.cacheKey).toBeUndefined();
    link.disconnect();
  });
});

describe('nothing auto-promotes', () => {
  // "The system proposes; the analyst commits. A canvas where objects wire
  // themselves is a canvas the analyst cannot trust or predict."
  it('records who committed it, on the node', () => {
    const { node } = accept(boxProposal(), 'chart-1', 'maya');
    expect(node.params.acceptedBy).toBe('maya');
    expect(node.params.fromSketch).toBe(true);
    expect(node.createdBy).toBe('agent');
  });

  it('refuses an acceptance with nobody behind it', () => {
    expect(() => accept(boxProposal(), 'chart-1', '   ')).toThrow(ProposalNotAcceptable);
  });

  // "On accept the ink stays, greyed and collapsible, linked to the node it
  // produced, because the sketch is often better documentation than the node."
  it('leaves the ink in place and linked', () => {
    const { ink } = accept(boxProposal(), 'chart-1', 'maya');
    expect(ink).toEqual({ strokeIds: ['s1'], state: 'greyed', linkedNodeId: 'chart-1' });
  });
});

describe('an ellipse is read as its own shape, not forced into a box', () => {
  it('recognizes it and still refuses an unresolvable chart', () => {
    const points = handDrawnEllipse(mulberry32(5));
    const recognition = recognizeShape(points);
    expect(recognition.kind).toBe('ellipse');

    const proposal = propose({
      shape: recognition,
      text: 'MU vs the sector',
      raw: { kind: 'chart', subject: 'MU', metrics: ['GM'] },
      resolve: resolver,
      strokeIds: ['s2'],
      bounds: { minX: 0, minY: 0, maxX: 200, maxY: 120 },
    });
    // MU resolves to nothing here, so the proposal blocks rather than guessing.
    expect(proposal.acceptable).toBe(false);
    expect(proposal.unresolved.map((u) => u.mention)).toContain('MU');
  });
});
