/**
 * PRD 7.1's node-drag row, and the behaviour its ceiling column states.
 *
 * > Node drag with 20 downstream nodes — 16ms p50, 40ms p95,
 * > **recompute deferred to drag-end**.
 *
 * Two claims in one line, and only one of them is about speed.
 *
 * The **behavioural** claim is the architectural one and it is
 * hardware-independent: while the analyst has hold of a node, nothing below it
 * computes. That is what `schedule`'s `dragging` input does, and it is checked
 * here rather than in `canvas-core` because the interesting version crosses
 * packages — the index has to move the node, the scene has to re-route the
 * edges, and the scheduler has to hold the subtree, all in the same frame.
 *
 * The **latency** claim is the frame cost of doing that. Measured under Node,
 * so it covers the CPU path Picasso wrote — index update, schedule, scene
 * assembly — and not the painting. A floor on the real number, and a ceiling on
 * the part this code controls, the same way the ink measurement is.
 *
 * What the deferral is worth is the third measurement, and it is the one that
 * makes the rule worth having: the same twenty downstream nodes, evaluated for
 * real in the pricing engine, once per frame.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  CanvasIndex,
  createDocument,
  createNode,
  markStale,
  moveNode,
  schedule,
  type CanvasDocument,
  type Edge,
  type NodeID,
  type Viewport,
} from '@picasso/canvas-core';
import { buildScene, lightTheme } from '@picasso/canvas-render';
import { GridPricer, type Leg, type Market } from '@picasso/canvas-pricing';
import { loadPricing } from './load.js';

const DOWNSTREAM = 20;

/** A dragged node feeding twenty others, laid out where they are all on screen. */
function canvas(): { doc: CanvasDocument; index: CanvasIndex; ids: NodeID[] } {
  const doc = createDocument('drag');
  const ids: NodeID[] = [];
  for (let i = 0; i <= DOWNSTREAM; i += 1) {
    const id = `n${i}`;
    ids.push(id);
    doc.nodes.set(
      id,
      createNode({
        id,
        kind: 'ChartNode',
        binding: 'wired',
        position: { x: (i % 6) * 280, y: Math.floor(i / 6) * 200 },
        size: { w: 240, h: 160 },
      }),
    );
    if (i > 0) {
      const edge: Edge = {
        id: `e${i}`,
        from: { nodeId: 'n0', portId: 'out' },
        to: { nodeId: id, portId: 'in' },
        class: 'data',
      };
      doc.edges.set(edge.id, edge);
    }
  }
  return { doc, index: new CanvasIndex(doc), ids };
}

const VIEWPORT: Viewport = { x: -100, y: -100, scale: 1, width: 1920, height: 1080 };

describe('the drag holds its subtree across the packages', () => {
  it('moves the node, re-routes the edges, and computes nothing below it', () => {
    const { doc, index } = canvas();
    markStale(doc, 'n0');

    moveNode(doc, index, 'n0', { x: 40, y: 25 });
    const held = schedule(doc, { visible: index.visible(VIEWPORT), dragging: ['n0'] });
    const scene = buildScene({ doc, index, viewport: VIEWPORT, theme: lightTheme, now: 0 });

    // Nothing evaluates.
    expect(held.order).toEqual([]);
    expect(held.heldByDrag.length).toBe(DOWNSTREAM + 1);
    // The edges are still drawn, from the node's new position.
    expect(scene.edges.length).toBe(DOWNSTREAM);
    // And the subtree renders stale rather than absent, which is the honest
    // state: those numbers no longer follow from their inputs.
    const drawn = [...scene.quads, ...scene.tiles, ...scene.dom];
    expect(drawn.length).toBe(DOWNSTREAM + 1);

    // Hand off: the same batch runs, in dependency order.
    const released = schedule(doc, { visible: index.visible(VIEWPORT) });
    expect(released.order.length).toBe(DOWNSTREAM + 1);
    expect(released.order[0]).toBe('n0');
    expect(released.heldByDrag).toEqual([]);
  });

  it('holds the subtree for every frame of the drag, not just the first', () => {
    const { doc, index } = canvas();
    for (let frame = 0; frame < 60; frame += 1) {
      moveNode(doc, index, 'n0', { x: frame * 3, y: frame * 2 });
      markStale(doc, 'n0');
      const result = schedule(doc, { visible: index.visible(VIEWPORT), dragging: ['n0'] });
      expect(result.order, `frame ${frame}`).toEqual([]);
    }
    // Sixty frames of invalidation, one batch at the end.
    expect(schedule(doc, { visible: index.visible(VIEWPORT) }).order.length).toBe(DOWNSTREAM + 1);
  });
});

describe('what a drag frame costs', () => {
  function percentile(sorted: readonly number[], q: number): number {
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number;
  }

  it('holds the 16ms p50 and 40ms p95 budget for the path this code owns', () => {
    const { doc, index } = canvas();
    const costs: number[] = [];

    for (let frame = 0; frame < 400; frame += 1) {
      // One pointer event: move, invalidate, schedule, assemble.
      const t0 = performance.now();
      moveNode(doc, index, 'n0', { x: (frame % 120) * 4, y: (frame % 90) * 3 });
      markStale(doc, 'n0');
      schedule(doc, { visible: index.visible(VIEWPORT), dragging: ['n0'] });
      buildScene({ doc, index, viewport: VIEWPORT, theme: lightTheme, now: frame * 16.6 });
      costs.push(performance.now() - t0);
    }

    costs.sort((a, b) => a - b);
    const p50 = percentile(costs, 0.5);
    const p95 = percentile(costs, 0.95);

    // Measured at p50 0.104ms, p95 0.306ms, worst 1.216ms. Under Node,
    // covering index update, invalidation, scheduling and scene assembly — not
    // painting, which the browser does. A floor on the real number and a
    // ceiling on the part Picasso wrote. Asserted at the PRD's budget rather
    // than at the measurement, so a regression has two orders of magnitude of
    // room before it fails here and the figure above is where to look first.
    expect(p50).toBeLessThan(16);
    expect(p95).toBeLessThan(40);
  });
});

describe('what the deferral is worth', () => {
  let pricer: GridPricer;
  beforeAll(async () => {
    pricer = new GridPricer(await loadPricing());
  }, 180_000);

  const LEGS: Leg[] = [
    { strike: 140, time: 0.35, kind: 'call', style: 'american', quantity: 40, multiplier: 100, vol: 0.52 },
    { strike: 105, time: 0.6, kind: 'put', style: 'american', quantity: 18, multiplier: 100, vol: 0.41 },
  ];
  const MARKET: Market = { spot: 118.5, rate: 0.0441, dividend: 0.004 };

  // The rule is worth having only if the thing it defers is expensive. A chart
  // node redrawing a cached series is cheap and the deferral would be a
  // nicety; a downstream node that reprices is not, and the PRD's twenty of
  // them is what the budget is written against.
  it('measures one real downstream evaluation, and what twenty per frame would cost', () => {
    const one = performance.now();
    pricer.reprice(LEGS, MARKET, { spotSteps: 5, spotRange: 0.1, volSteps: 3, volRange: 0.05 });
    const perNode = performance.now() - one;

    const perFrame = perNode * DOWNSTREAM;
    // Measured at 6.55ms for one and 131ms for twenty, against a 40ms p95. The
    // figure is machine-dependent and the conclusion is not: a small grid of
    // American legs goes through Andersen-Lake, and no plausible machine makes
    // twenty of those fit in a frame. That is why the PRD defers them rather
    // than optimising them — and it is the difference between 131ms a frame and
    // the 0.3ms the test above measures.
    expect(perNode).toBeGreaterThan(0);
    expect(perFrame).toBeGreaterThan(40);
  });
});
