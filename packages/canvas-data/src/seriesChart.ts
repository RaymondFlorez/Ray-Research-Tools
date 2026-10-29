/**
 * A `ChartNode` drawing one fact series as the canvas's time sees it
 * (PRD 3.3, 3.8).
 *
 * The fact tile shows the latest period; a chart shows every period in its
 * range, each at the value known at the canvas's time — so a chart on a canvas
 * scrubbed to a morning draws the line that was on the screen that morning, not
 * today's restated one. It reads through a `PointInTimeSource`, the in-process
 * store or the Go data plane, and the two must agree.
 *
 * **A withheld period is a gap where it falls.** The points come back as one
 * ordered array in which a period this reader may not see is an entry with a
 * reason and no value. A line drawn through the points breaks there instead of
 * joining its neighbours as though the period were not there, and nothing
 * stands in for it — in particular not an older version the reader happens to
 * be allowed, which the data plane never returns anyway.
 */

import { createNode, type NodeID, type PicassoNode, type Vec2 } from '@picasso/canvas-core';
import type { Instant } from './bitemporal.js';
import type { PointInTimeSource } from './factTile.js';
import { knowledgeTimeFor, type CanvasTime } from './timescrub.js';

export function createSeriesChart(input: { id: NodeID; key: string; from?: Instant; to?: Instant; position?: Vec2 }): PicassoNode {
  return createNode({
    id: input.id,
    kind: 'ChartNode',
    binding: 'wired',
    position: input.position ?? { x: 0, y: 0 },
    size: { w: 420, h: 240 },
    outputs: [{ id: 'series', name: 'Series', type: 'series', cardinality: 'one', required: false }],
    params: {
      key: input.key,
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
    },
  });
}

export type ChartPoint =
  | { validTime: Instant; value: number; knownAt: Instant }
  | { validTime: Instant; withheld: string };

export type SeriesChartValue =
  | { kind: 'series'; key: string; points: ChartPoint[]; asof: Instant; source: string }
  /** The canvas moved while the read was in flight; nothing was written. */
  | { kind: 'superseded'; key: string; asof: Instant };

/** Reads the chart's series at the canvas's time and settles the node. */
export async function evaluateSeriesChart(
  node: PicassoNode,
  source: PointInTimeSource,
  time: CanvasTime,
  now: () => Instant,
): Promise<SeriesChartValue> {
  const key = String(node.params.key ?? '');
  const range = {
    ...(typeof node.params.from === 'string' ? { from: node.params.from } : {}),
    ...(typeof node.params.to === 'string' ? { to: node.params.to } : {}),
  };
  const asof = knowledgeTimeFor(time, now);
  node.provenance = { ...node.provenance, asof };
  node.state = { ...node.state, status: 'computing' };

  const read = await source.read({ key, knowledgeTime: asof, ...range });
  if (node.provenance.asof !== asof) return { kind: 'superseded', key, asof };

  const points: ChartPoint[] = [
    ...read.observations.map((o) => ({ validTime: o.validTime, value: o.value, knownAt: o.knownAt })),
    ...read.blocked.map((b) => ({ validTime: b.validTime, withheld: b.message })),
  ].sort((a, b) => (a.validTime < b.validTime ? -1 : a.validTime > b.validTime ? 1 : 0));
  node.state = { status: 'ready', lastComputedAt: Date.now() };
  return { kind: 'series', key, points, asof, source: source.name };
}
