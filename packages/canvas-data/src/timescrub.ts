/**
 * Dataset snapshots and the global time scrub (PRD 3.8, 3.9, 3.4.3).
 *
 * "Setting the canvas `asof` to 2024-08-05 makes every node on the canvas show
 * what it would have shown that morning, using point-in-time data with no
 * restatement leakage. This is the single most valuable feature for anyone who
 * wants to know whether their framework would actually have worked."
 *
 * Two things make that true rather than merely intended.
 *
 * **The asof resolves to snapshot IDs, not to a timestamp.** A timestamp is a
 * request that each source interpret history for itself; a snapshot ID is a
 * commitment. `SnapshotCatalog` maps an instant to the exact Iceberg snapshot
 * per source, and those IDs land in every node's provenance and therefore in
 * every cache key. Two reads at the same asof are the same read.
 *
 * **Changing the asof marks nodes stale with a reason.** A number that moves
 * because the analyst scrubbed time is a different event from a number that
 * moved because the market did, and the canvas says which.
 */

import type { CanvasDocument, NodeID } from '@picasso/canvas-core';
import type { Instant } from './bitemporal.js';

/** source -> Iceberg snapshot ID. Exactly `ProvenanceRef.datasetSnapshots`. */
export type SnapshotSet = Record<string, string>;

export interface DatasetSnapshot {
  source: string;
  snapshotId: string;
  /** Everything committed at or before this instant is in the snapshot. */
  committedAt: Instant;
}

/**
 * Resolves a canvas asof to one snapshot per source.
 *
 * In production this is the Iceberg catalog. The semantics are what matter and
 * are what the tests hold: the newest snapshot committed at or before the asof,
 * per source, deterministically.
 */
export class SnapshotCatalog {
  private readonly bySource = new Map<string, DatasetSnapshot[]>();

  register(snapshot: DatasetSnapshot): void {
    const list = this.bySource.get(snapshot.source);
    if (list) {
      list.push(snapshot);
      list.sort((a, b) => (a.committedAt < b.committedAt ? -1 : a.committedAt > b.committedAt ? 1 : 0));
    } else {
      this.bySource.set(snapshot.source, [snapshot]);
    }
  }

  registerAll(snapshots: Iterable<DatasetSnapshot>): void {
    for (const snapshot of snapshots) this.register(snapshot);
  }

  get sources(): string[] {
    return [...this.bySource.keys()].sort();
  }

  /** The snapshot in force for one source at `asof`. */
  resolveSource(source: string, asof: Instant): DatasetSnapshot | undefined {
    const list = this.bySource.get(source);
    if (!list) return undefined;
    let found: DatasetSnapshot | undefined;
    for (const snapshot of list) {
      if (snapshot.committedAt <= asof) found = snapshot;
      else break;
    }
    return found;
  }

  /**
   * The full snapshot set for an asof.
   *
   * A source with no snapshot at that instant is *absent* rather than defaulted
   * to its earliest: a canvas scrubbed to before a source existed should show
   * that source as unavailable, not silently substitute the oldest data it has.
   */
  resolve(asof: Instant): SnapshotSet {
    const set: SnapshotSet = {};
    for (const source of this.sources) {
      const snapshot = this.resolveSource(source, asof);
      if (snapshot) set[source] = snapshot.snapshotId;
    }
    return set;
  }

  /** Sources with no data at `asof`, so the canvas can say so. */
  missingAt(asof: Instant): string[] {
    return this.sources.filter((source) => this.resolveSource(source, asof) === undefined);
  }
}

/** Why a node went stale. The analyst needs to tell these apart. */
export type StaleReason =
  | 'asof_changed'
  | 'upstream_changed'
  | 'param_changed'
  | 'model_version_changed';

export interface ScrubResult {
  asof: Instant;
  snapshots: SnapshotSet;
  /** Nodes marked stale by the scrub. */
  invalidated: NodeID[];
  /** Sources with no snapshot at this asof. */
  missingSources: string[];
  /** Loose objects, which never schedule and are untouched by time. */
  skippedLoose: NodeID[];
}

export interface ScrubOptions {
  /** Records why each node went stale, for the node's status tooltip. */
  reasons?: Map<NodeID, StaleReason>;
}

/**
 * Sets the canvas asof.
 *
 * Every non-loose node is marked stale and re-stamped with the resolved
 * snapshot set, so its next evaluation reads history rather than today. Loose
 * objects are untouched: ink and sticky notes have no asof because they were
 * never computed from anything.
 */
export function setCanvasAsOf(
  doc: CanvasDocument,
  asof: Instant,
  catalog: SnapshotCatalog,
  options: ScrubOptions = {},
): ScrubResult {
  const snapshots = catalog.resolve(asof);
  const invalidated: NodeID[] = [];
  const skippedLoose: NodeID[] = [];

  for (const node of doc.nodes.values()) {
    if (node.binding === 'loose') {
      skippedLoose.push(node.id);
      continue;
    }

    node.provenance = {
      ...node.provenance,
      asof,
      datasetSnapshots: { ...snapshots },
    };
    node.state = { ...node.state, status: 'stale' };
    delete node.state.cacheKey;
    invalidated.push(node.id);
    options.reasons?.set(node.id, 'asof_changed');
  }

  return {
    asof,
    snapshots,
    invalidated,
    missingSources: catalog.missingAt(asof),
    skippedLoose,
  };
}

/**
 * Whether two scrubs resolved to the same data.
 *
 * This is the reproducibility check the exit criterion rests on: reopening a
 * named version, or scrubbing back to a morning twice, must resolve to an
 * identical snapshot set, or the numbers are free to move underneath.
 */
export function sameSnapshots(a: SnapshotSet, b: SnapshotSet): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key, i) => key === keysB[i] && a[key] === b[key]);
}

/**
 * The asof a canvas is pinned to, or live.
 *
 * `live` is not a timestamp: a live canvas follows the tape, and pinning it to
 * `now` at the moment of asking would freeze it a millisecond later.
 */
export type CanvasTime = { mode: 'live' } | { mode: 'pinned'; asof: Instant };

export function isPinned(time: CanvasTime): time is { mode: 'pinned'; asof: Instant } {
  return time.mode === 'pinned';
}

/** The knowledge time to read at: the pin, or the current instant. */
export function knowledgeTimeFor(time: CanvasTime, now: () => Instant): Instant {
  return time.mode === 'pinned' ? time.asof : now();
}
