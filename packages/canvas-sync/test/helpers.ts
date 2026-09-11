import { createNode, type Edge, type PicassoNode } from '@picasso/canvas-core';
import { SyncedCanvas } from '../src/canvas.js';

export function node(id: string, over: Partial<Parameters<typeof createNode>[0]> = {}): PicassoNode {
  return createNode({
    id,
    kind: 'ChartNode',
    binding: 'wired',
    position: { x: 0, y: 0 },
    size: { w: 200, h: 140 },
    ...over,
  });
}

export function edge(id: string, from: string, to: string): Edge {
  return {
    id,
    from: { nodeId: from, portId: 'out' },
    to: { nodeId: to, portId: 'in' },
    class: 'data',
  };
}

/** Structure only: what every peer must agree on, in a comparable form. */
export function structure(canvas: SyncedCanvas): string {
  const doc = canvas.snapshot();
  const nodes = [...doc.nodes.values()]
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      binding: n.binding,
      position: n.position,
      size: n.size,
      params: Object.fromEntries(Object.entries(n.params).sort(([a], [b]) => (a < b ? -1 : 1))),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const edges = [...doc.edges.values()]
    .map((e) => ({ id: e.id, from: e.from, to: e.to, class: e.class }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const ink = canvas
    .strokes()
    .map((s) => ({ id: s.id, points: s.runs.flatMap((r) => r.points.map((p) => [p.x, p.y])) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return JSON.stringify({ nodes, edges, ink });
}

export function inkPoint(x: number, y: number, t = 0) {
  return { x, y, pressure: 0.5, t };
}
