/**
 * The event ribbon (PRD 3.6).
 *
 * > **Event ribbon.** A horizontal strip along the canvas top showing the last
 * > 90 minutes of firing events across all nodes, positioned by time. Clicking
 * > a mark flies the viewport to the responsible node.
 *
 * Three things a strip of dots gets wrong without trying.
 *
 * ## Marks that land on the same pixel are one mark that says so
 *
 * Ninety minutes across a strip a thousand pixels wide is 5.4 seconds a pixel,
 * and detectors on correlated series fire together — a rates shock lights up
 * every node downstream of the curve inside a second. Drawn naively those
 * marks stack on one pixel and the click lands on whichever was drawn last.
 * Marks closer than `CLUSTER_PX` are merged into one that carries every node,
 * the count, and the worst severity; clicking it frames all of them, because
 * "what fired at 10:42" is the question and the answer is all of it.
 *
 * ## A node that has gone is still an event
 *
 * The node that fired may have been deleted since. Its mark stays — something
 * did happen at that time, and a ribbon that silently drops it rewrites the
 * last ninety minutes — but it cannot be flown to, and it is drawn as such.
 *
 * ## A mark from the future is pinned to now, and flagged
 *
 * Firings come from peers and from the server, and a clock a few seconds ahead
 * places a mark past the right edge where nothing can reach it. It is drawn at
 * the right edge and marked `clockAhead`, rather than dropped or trusted.
 */

import { boundsOf, flyTo, type CanvasDocument, type NodeID, type Viewport } from '@picasso/canvas-core';
import { severityFor, type Severity } from './wash.js';

/** PRD 3.6: "the last 90 minutes". */
export const RIBBON_WINDOW_MS = 90 * 60_000;

/** Marks closer than this are one mark. */
export const CLUSTER_PX = 6;

/** How close to a mark a click has to land. */
export const HIT_PX = 5;

export interface RibbonEvent {
  nodeId: NodeID;
  /** Which detector fired, for the mark's tooltip. */
  family: string;
  /** In robust standard deviations, as the detectors report it. */
  severity: number;
  at: number;
}

export interface RibbonMark {
  x: number;
  /** Earliest and latest event in the mark. */
  from: number;
  to: number;
  events: RibbonEvent[];
  /** Nodes still on the canvas, which the mark can fly to. */
  nodeIds: NodeID[];
  /** Nodes that fired and have since been removed. */
  goneIds: NodeID[];
  /** Graded from the worst event in the mark. */
  severity: Severity;
  worst: number;
  /** Some event carried a timestamp ahead of the ribbon's clock. */
  clockAhead: boolean;
}

export class EventRibbon {
  private events: RibbonEvent[] = [];

  constructor(private readonly windowMs = RIBBON_WINDOW_MS) {}

  add(event: RibbonEvent): void {
    this.events.push(event);
  }

  /** Drops what has scrolled off the left edge. */
  prune(now: number): void {
    const start = now - this.windowMs;
    this.events = this.events.filter((e) => e.at >= start);
  }

  /** The marks to draw across a strip `widthPx` wide, left (oldest) to right. */
  layout(doc: CanvasDocument, now: number, widthPx: number): RibbonMark[] {
    this.prune(now);
    const start = now - this.windowMs;
    const placed = this.events
      .map((event) => {
        const clockAhead = event.at > now;
        const at = clockAhead ? now : event.at;
        return { event, clockAhead, x: ((at - start) / this.windowMs) * widthPx };
      })
      .sort((a, b) => a.x - b.x || a.event.at - b.event.at);

    const marks: RibbonMark[] = [];
    let group: typeof placed = [];
    const flush = () => {
      if (group.length === 0) return;
      const events = group.map((g) => g.event);
      const ids = [...new Set(events.map((e) => e.nodeId))];
      const worst = Math.max(...events.map((e) => e.severity));
      marks.push({
        x: group.reduce((a, g) => a + g.x, 0) / group.length,
        from: Math.min(...events.map((e) => e.at)),
        to: Math.max(...events.map((e) => e.at)),
        events,
        nodeIds: ids.filter((id) => doc.nodes.has(id)),
        goneIds: ids.filter((id) => !doc.nodes.has(id)),
        severity: severityFor(worst),
        worst,
        clockAhead: group.some((g) => g.clockAhead),
      });
      group = [];
    };
    for (const p of placed) {
      // Chain from the group's first mark, not its last: otherwise a steady
      // drizzle of events a few pixels apart merges into one mark spanning
      // the whole strip.
      if (group.length > 0 && p.x - group[0]!.x > CLUSTER_PX) flush();
      group.push(p);
    }
    flush();
    return marks;
  }
}

/** The mark under a click, if any: the nearest within `HIT_PX`. */
export function markAt(marks: readonly RibbonMark[], x: number): RibbonMark | undefined {
  let best: RibbonMark | undefined;
  let distance = HIT_PX;
  for (const mark of marks) {
    const d = Math.abs(mark.x - x);
    if (d <= distance) {
      best = mark;
      distance = d;
    }
  }
  return best;
}

export class NothingToFlyTo extends Error {
  constructor(readonly mark: RibbonMark) {
    super(
      `every node in this mark (${mark.goneIds.join(', ')}) has been removed since it fired; ` +
        'the event is kept on the ribbon, and there is nowhere left to go',
    );
    this.name = 'NothingToFlyTo';
  }
}

/**
 * The viewport a click on a mark flies to: every node in it that is still
 * there, framed together by `canvas-core`'s own `flyTo`.
 */
export function flyToMark(doc: CanvasDocument, viewport: Viewport, mark: RibbonMark): Viewport {
  const bounds = boundsOf(doc, mark.nodeIds);
  if (!bounds) throw new NothingToFlyTo(mark);
  return flyTo(viewport, bounds);
}
