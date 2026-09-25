import { describe, expect, it } from 'vitest';
import {
  addNode,
  boundsOf,
  createDocument,
  createNode,
  flyTo,
  type CanvasDocument,
  type Viewport,
} from '@picasso/canvas-core';
import {
  CLUSTER_PX,
  EventRibbon,
  NothingToFlyTo,
  RIBBON_WINDOW_MS,
  flyToMark,
  markAt,
} from '../src/ribbon.js';

const NOW = Date.UTC(2026, 2, 11, 15, 0);
const MINUTE = 60_000;
const WIDTH = 900;
const VIEWPORT: Viewport = { x: 0, y: 0, scale: 1, width: 1440, height: 900 };

function canvas(): CanvasDocument {
  const doc = createDocument('c');
  for (const [id, x] of [['ust10', 0], ['swaps', 400], ['nvda', 2000], ['amd', 2400]] as const) {
    addNode(doc, createNode({ id, kind: 'ChartNode', binding: 'wired', position: { x, y: 0 }, size: { w: 200, h: 120 } }));
  }
  return doc;
}

describe('the event ribbon', () => {
  it('places marks by time across the last ninety minutes', () => {
    const ribbon = new EventRibbon();
    ribbon.add({ nodeId: 'nvda', family: 'robust_z', severity: 5, at: NOW - 90 * MINUTE });
    ribbon.add({ nodeId: 'amd', family: 'bocpd', severity: 3, at: NOW - 45 * MINUTE });
    ribbon.add({ nodeId: 'ust10', family: 'stl_residual', severity: 8, at: NOW });
    const marks = ribbon.layout(canvas(), NOW, WIDTH);
    expect(marks.map((m) => Math.round(m.x))).toEqual([0, 450, 900]);
    // Graded as the wash grades a halo: five sd and up is high, three medium.
    expect(marks.map((m) => m.severity)).toEqual(['high', 'medium', 'high']);
  });

  it('drops what has scrolled off the left edge', () => {
    const ribbon = new EventRibbon();
    ribbon.add({ nodeId: 'nvda', family: 'robust_z', severity: 5, at: NOW - RIBBON_WINDOW_MS - 1 });
    ribbon.add({ nodeId: 'amd', family: 'bocpd', severity: 3, at: NOW - 10 * MINUTE });
    expect(ribbon.layout(canvas(), NOW, WIDTH).map((m) => m.events[0]!.nodeId)).toEqual(['amd']);
  });

  it('merges events on the same pixel into one mark that carries all of them', () => {
    // A rates shock lights up everything downstream of the curve inside a
    // second: one pixel, and a click has to mean all of it.
    const ribbon = new EventRibbon();
    ribbon.add({ nodeId: 'ust10', family: 'bocpd', severity: 4, at: NOW - 20 * MINUTE });
    ribbon.add({ nodeId: 'swaps', family: 'bocpd', severity: 6.5, at: NOW - 20 * MINUTE + 800 });
    ribbon.add({ nodeId: 'nvda', family: 'robust_z', severity: 2.5, at: NOW - 20 * MINUTE + 1500 });
    const [mark, ...rest] = ribbon.layout(canvas(), NOW, WIDTH);
    expect(rest).toEqual([]);
    expect(mark!.events).toHaveLength(3);
    expect(mark!.nodeIds.sort()).toEqual(['nvda', 'swaps', 'ust10']);
    expect(mark!.worst).toBe(6.5);
    expect(mark!.severity).toBe('high');
  });

  it('does not chain a steady drizzle into one mark spanning the strip', () => {
    const ribbon = new EventRibbon();
    // An event every 4 px for the whole ninety minutes.
    const step = (RIBBON_WINDOW_MS / WIDTH) * 4;
    for (let t = NOW - RIBBON_WINDOW_MS; t <= NOW; t += step) {
      ribbon.add({ nodeId: 'nvda', family: 'robust_z', severity: 4, at: t });
    }
    const marks = ribbon.layout(canvas(), NOW, WIDTH);
    expect(marks.length).toBeGreaterThan(WIDTH / (CLUSTER_PX + 4));
    for (const m of marks) {
      const span = ((m.to - m.from) / RIBBON_WINDOW_MS) * WIDTH;
      expect(span).toBeLessThanOrEqual(CLUSTER_PX);
    }
  });

  it('pins a mark from a clock ahead of ours to the right edge, and says so', () => {
    const ribbon = new EventRibbon();
    ribbon.add({ nodeId: 'nvda', family: 'robust_z', severity: 5, at: NOW + 4_000 });
    const [mark] = ribbon.layout(canvas(), NOW, WIDTH);
    expect(mark!.x).toBe(WIDTH);
    expect(mark!.clockAhead).toBe(true);
  });
});

describe('clicking a mark', () => {
  it('finds the nearest mark within a few pixels, and nothing further away', () => {
    const ribbon = new EventRibbon();
    ribbon.add({ nodeId: 'nvda', family: 'robust_z', severity: 5, at: NOW - 45 * MINUTE });
    const marks = ribbon.layout(canvas(), NOW, WIDTH);
    expect(markAt(marks, 452)?.events[0]!.nodeId).toBe('nvda');
    expect(markAt(marks, 470)).toBeUndefined();
  });

  it('flies to the node that fired, framed as the palette frames it', () => {
    const doc = canvas();
    const ribbon = new EventRibbon();
    ribbon.add({ nodeId: 'nvda', family: 'robust_z', severity: 5, at: NOW - 5 * MINUTE });
    const [mark] = ribbon.layout(doc, NOW, WIDTH);
    expect(flyToMark(doc, VIEWPORT, mark!)).toEqual(flyTo(VIEWPORT, boundsOf(doc, ['nvda'])!));
  });

  it('frames every node in a merged mark together', () => {
    const doc = canvas();
    const ribbon = new EventRibbon();
    ribbon.add({ nodeId: 'ust10', family: 'bocpd', severity: 4, at: NOW - MINUTE });
    ribbon.add({ nodeId: 'amd', family: 'bocpd', severity: 4, at: NOW - MINUTE + 500 });
    const [mark] = ribbon.layout(doc, NOW, WIDTH);
    expect(flyToMark(doc, VIEWPORT, mark!)).toEqual(flyTo(VIEWPORT, boundsOf(doc, ['ust10', 'amd'])!));
  });

  it('keeps an event whose node has gone, and refuses to fly to it', () => {
    const doc = canvas();
    const ribbon = new EventRibbon();
    ribbon.add({ nodeId: 'nvda', family: 'robust_z', severity: 5, at: NOW - 5 * MINUTE });
    doc.nodes.delete('nvda');
    const [mark] = ribbon.layout(doc, NOW, WIDTH);
    // Something did happen at that time; dropping it rewrites the history.
    expect(mark!.goneIds).toEqual(['nvda']);
    expect(mark!.nodeIds).toEqual([]);
    expect(() => flyToMark(doc, VIEWPORT, mark!)).toThrow(NothingToFlyTo);
  });
});
