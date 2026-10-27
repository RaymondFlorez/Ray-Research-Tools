/**
 * A tile that shows one fact as the canvas's time sees it (PRD 3.3, 3.8).
 *
 * "Setting the canvas `asof` to 2024-08-05 makes every node on the canvas show
 * what it would have shown that morning." `setCanvasAsOf` re-pins the nodes
 * and marks them stale; this is the evaluation that follows, for a DataTile
 * holding a fact key such as `NVDA.revenue`: read at the canvas's time, show
 * the latest period known then, and say when it became known.
 *
 * The read goes through a `PointInTimeSource`, so the same tile evaluates
 * against the in-process `BitemporalStore` or against the Go data plane on
 * Postgres (`RemotePointInTime`), and the two must agree; the remote morning
 * check holds them to it.
 *
 * Two rules, both easy to get wrong in the direction of showing a number:
 *
 *   - **The latest period blocked is the tile blocked.** If Q3 exists and the
 *     reader may not see it, the tile does not fall back to Q2 as though Q2
 *     were the latest — that is a stale number with no badge.
 *   - **A read that lands after the canvas moved is discarded.** Reads are
 *     asynchronous; a scrub can move the canvas while one is in flight. An
 *     answer for 2024-08-05 must not settle on a node that now says 2026.
 */

import { createNode, type NodeID, type PicassoNode, type Vec2 } from '@picasso/canvas-core';
import type { AsOfQuery, BitemporalStore, Instant } from './bitemporal.js';
import type { RemotePointInTime } from './remote.js';
import { knowledgeTimeFor, type CanvasTime } from './timescrub.js';

export interface SourceRead {
  observations: Array<{ validTime: Instant; value: number; knownAt: Instant; source?: string }>;
  blocked: Array<{ validTime: Instant; message: string }>;
}

/** Where a tile reads from. */
export interface PointInTimeSource {
  /** What the source is, in the analyst's terms: shown under the number. */
  readonly name: string;
  read(query: AsOfQuery): Promise<SourceRead>;
}

/** The in-process store. It holds no classes, so nothing in it is blocked. */
export function localSource(store: BitemporalStore<number>, name = 'local store'): PointInTimeSource {
  return {
    name,
    read: async (query) => ({
      observations: store.asOf(query).map((o) => ({
        validTime: o.validTime,
        value: o.value,
        knownAt: o.knownAt,
        ...(o.source !== undefined ? { source: o.source } : {}),
      })),
      blocked: [],
    }),
  };
}

/** The data plane, under the client's user and entitlements. */
export function remoteSource(remote: RemotePointInTime, name = 'data plane'): PointInTimeSource {
  return {
    name,
    read: async (query) => {
      const r = await remote.asOf(query);
      return {
        observations: r.observations.map((o) => ({
          validTime: o.validTime,
          value: o.value,
          knownAt: o.knownAt,
          ...(o.source !== undefined ? { source: o.source } : {}),
        })),
        blocked: r.blocked.map((b) => ({ validTime: b.validTime, message: b.decision.message })),
      };
    },
  };
}

export function createFactTile(input: { id: NodeID; key: string; position?: Vec2 }): PicassoNode {
  return createNode({
    id: input.id,
    kind: 'DataTile',
    binding: 'wired',
    position: input.position ?? { x: 0, y: 0 },
    size: { w: 220, h: 120 },
    outputs: [{ id: 'value', name: 'Value', type: 'scalar', cardinality: 'one', required: false }],
    params: { key: input.key },
  });
}

export type FactTileValue =
  | {
      kind: 'value';
      key: string;
      /** The period shown: the latest one known at the canvas's time. */
      validTime: Instant;
      value: number;
      /** When that value became known. */
      knownAt: Instant;
      /** The knowledge time the read was made at. */
      asof: Instant;
      source: string;
    }
  | { kind: 'blocked'; key: string; validTime: Instant; message: string; asof: Instant }
  /** Nothing about this key was known at the canvas's time — not zero. */
  | { kind: 'empty'; key: string; asof: Instant }
  /** The canvas moved while the read was in flight; nothing was written. */
  | { kind: 'superseded'; key: string; asof: Instant };

/**
 * Reads the tile's fact at the canvas's time and settles the node.
 *
 * The node's provenance is stamped with the knowledge time before the read,
 * and the answer is written only if it is still the node's knowledge time when
 * the read returns.
 */
export async function evaluateFactTile(
  node: PicassoNode,
  source: PointInTimeSource,
  time: CanvasTime,
  now: () => Instant,
): Promise<FactTileValue> {
  const key = String(node.params.key ?? '');
  const asof = knowledgeTimeFor(time, now);
  node.provenance = { ...node.provenance, asof };
  node.state = { ...node.state, status: 'computing' };

  const read = await source.read({ key, knowledgeTime: asof });
  if (node.provenance.asof !== asof) return { kind: 'superseded', key, asof };

  const latestShown = read.observations[read.observations.length - 1];
  const latestBlocked = read.blocked.reduce<SourceRead['blocked'][number] | undefined>(
    (best, b) => (best === undefined || b.validTime > best.validTime ? b : best),
    undefined,
  );
  node.state = { status: 'ready', lastComputedAt: Date.now() };

  if (latestBlocked && (!latestShown || latestBlocked.validTime >= latestShown.validTime)) {
    return { kind: 'blocked', key, validTime: latestBlocked.validTime, message: latestBlocked.message, asof };
  }
  if (!latestShown) return { kind: 'empty', key, asof };
  return {
    kind: 'value',
    key,
    validTime: latestShown.validTime,
    value: latestShown.value,
    knownAt: latestShown.knownAt,
    asof,
    source: latestShown.source ? `${source.name} · ${latestShown.source}` : source.name,
  };
}
