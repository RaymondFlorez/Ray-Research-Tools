/**
 * Artifact tiering (PRD 7.3, "Cost control").
 *
 * > Cold canvases evict their cached artifacts to S3 after 7 days; reopening
 * > rehydrates lazily.
 *
 * ## Cold means unopened, not unedited
 *
 * A canvas the desk head reads every morning and never edits is the opposite of
 * cold. "Last modified" would evict it on day eight and make every morning's
 * open pay for a rehydration. Coldness is measured from the last *open*.
 *
 * ## Lazily means per artifact, on read
 *
 * Reopening a 10,000-node canvas does not pull ten thousand artifacts back. The
 * viewport decides what is computed (PRD 3.4.2), so the viewport decides what is
 * rehydrated: an artifact comes back the first time something reads it, and one
 * nobody scrolls to stays in cold storage.
 *
 * ## What comes back is checked against what went out
 *
 * A cache key is derived from a node's *inputs*, so it cannot vouch for the
 * bytes stored under it. A digest of the artifact is taken at eviction and
 * checked at rehydration; an artifact that does not match is treated as a
 * cache miss — the node recomputes — rather than served, because a corrupted
 * cached value presented as a computed one is the failure PRD 7.4's rule is
 * about: "the system never shows a number without telling the truth about
 * where it came from."
 */

import { hash } from '@picasso/canvas-core';

/** PRD 7.3: "after 7 days". */
export const COLD_AFTER_MS = 7 * 24 * 3_600_000;

/** Where evicted artifacts go. S3 implements this; the tests use a Map. */
export interface ColdStore {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryColdStore implements ColdStore {
  readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key);
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

interface Evicted {
  digest: string;
}

export type ReadOutcome =
  | { status: 'hot'; artifact: string }
  | { status: 'rehydrated'; artifact: string }
  | { status: 'miss' }
  | { status: 'corrupt'; reason: string };

export interface SweepReport {
  canvases: string[];
  artifacts: number;
}

/**
 * The cache for one service: hot artifacts in memory, cold ones elsewhere.
 *
 * Artifacts are strings — the serialized output a node's cache key names —
 * and are addressed by canvas and cache key.
 */
export class ArtifactTiers {
  private readonly hot = new Map<string, Map<string, string>>();
  private readonly cold = new Map<string, Map<string, Evicted>>();
  private readonly lastOpened = new Map<string, number>();
  /** Cold objects superseded by a fresh write, deleted at the next sweep. */
  private readonly orphans = new Set<string>();

  constructor(
    private readonly store: ColdStore,
    private readonly coldAfterMs = COLD_AFTER_MS,
  ) {}

  /** Records an open. Reading an artifact does not count; opening the canvas does. */
  opened(canvasId: string, now: number): void {
    this.lastOpened.set(canvasId, now);
  }

  put(canvasId: string, cacheKey: string, artifact: string): void {
    let artifacts = this.hot.get(canvasId);
    if (!artifacts) {
      artifacts = new Map();
      this.hot.set(canvasId, artifacts);
    }
    artifacts.set(cacheKey, artifact);
    // A fresh write supersedes whatever was evicted under the same key. `put`
    // is synchronous and the cold store is not, so the object is queued for
    // the next sweep rather than left in the bucket for ever.
    if (this.cold.get(canvasId)?.delete(cacheKey)) this.orphans.add(coldKey(canvasId, cacheKey));
  }

  /**
   * Moves every artifact of every canvas unopened for seven days to cold
   * storage, with a digest of each.
   */
  async sweep(now: number): Promise<SweepReport> {
    for (const key of this.orphans) await this.store.delete(key);
    this.orphans.clear();
    const canvases: string[] = [];
    let artifacts = 0;
    for (const [canvasId, entries] of this.hot) {
      const opened = this.lastOpened.get(canvasId) ?? Number.NEGATIVE_INFINITY;
      if (now - opened < this.coldAfterMs) continue;
      let evicted = this.cold.get(canvasId);
      if (!evicted) {
        evicted = new Map();
        this.cold.set(canvasId, evicted);
      }
      for (const [cacheKey, artifact] of entries) {
        await this.store.put(coldKey(canvasId, cacheKey), artifact);
        evicted.set(cacheKey, { digest: hash(artifact) });
        artifacts += 1;
      }
      this.hot.delete(canvasId);
      canvases.push(canvasId);
    }
    return { canvases, artifacts };
  }

  /**
   * Reads an artifact, rehydrating it from cold storage if that is where it is.
   *
   * A rehydrated artifact is checked against the digest taken when it left; one
   * that does not match is reported `corrupt` and dropped, so the caller
   * recomputes instead of showing it.
   */
  async read(canvasId: string, cacheKey: string): Promise<ReadOutcome> {
    const hotValue = this.hot.get(canvasId)?.get(cacheKey);
    if (hotValue !== undefined) return { status: 'hot', artifact: hotValue };

    const evicted = this.cold.get(canvasId)?.get(cacheKey);
    if (!evicted) return { status: 'miss' };

    const key = coldKey(canvasId, cacheKey);
    const artifact = await this.store.get(key);
    this.cold.get(canvasId)!.delete(cacheKey);
    if (artifact === undefined) {
      return { status: 'corrupt', reason: `${cacheKey} was evicted and is not in cold storage` };
    }
    if (hash(artifact) !== evicted.digest) {
      await this.store.delete(key);
      return {
        status: 'corrupt',
        reason: `${cacheKey} came back from cold storage different from what went out; recompute it`,
      };
    }
    this.put(canvasId, cacheKey, artifact);
    await this.store.delete(key);
    return { status: 'rehydrated', artifact };
  }

  /** Artifacts held in memory for a canvas, for the tests and the minimap. */
  hotCount(canvasId: string): number {
    return this.hot.get(canvasId)?.size ?? 0;
  }

  coldCount(canvasId: string): number {
    return this.cold.get(canvasId)?.size ?? 0;
  }
}

function coldKey(canvasId: string, cacheKey: string): string {
  return `${canvasId}/${cacheKey}`;
}
