/**
 * DOM mount lifecycle (PRD 3.1).
 *
 * "Mounting and unmounting DOM on LOD crossing is debounced 120ms to prevent
 * thrash during a scroll-wheel zoom."
 *
 * The debounce applies to *LOD* changes only. A node that enters or leaves the
 * viewport mounts and unmounts immediately, because that change is caused by a
 * pan and the 1.5-screen cull margin has already prefetched it; delaying it
 * would show holes where nodes should be.
 */

import { LOD_DEBOUNCE_MS, type LOD, type NodeID } from '@picasso/canvas-core';

/** DOM mounts at LOD2 and above; LOD0 and LOD1 are drawn on the GPU. */
export const DOM_LOD_FLOOR: LOD = 2;

export interface MountCandidate {
  id: NodeID;
  lod: LOD;
  visible: boolean;
}

export interface MountDiff {
  mounted: ReadonlySet<NodeID>;
  added: NodeID[];
  removed: NodeID[];
}

interface TrackedNode {
  lod: LOD;
  visible: boolean;
  /** What the node's LOD and visibility say it should be right now. */
  desired: boolean;
  /** When `desired` last disagreed with the committed state. */
  pendingSince?: number;
}

export class DomMountManager {
  private tracked = new Map<NodeID, TrackedNode>();
  private mountedSet = new Set<NodeID>();

  constructor(private readonly debounceMs = LOD_DEBOUNCE_MS) {}

  get mounted(): ReadonlySet<NodeID> {
    return this.mountedSet;
  }

  /**
   * Feeds the current frame's candidates and returns what the DOM layer should
   * mount and unmount. Candidates absent from the list are treated as gone.
   */
  update(candidates: Iterable<MountCandidate>, now: number): MountDiff {
    const added: NodeID[] = [];
    const removed: NodeID[] = [];
    const seen = new Set<NodeID>();

    for (const candidate of candidates) {
      seen.add(candidate.id);
      const desired = candidate.visible && candidate.lod >= DOM_LOD_FLOOR;
      const prior = this.tracked.get(candidate.id);

      if (!prior) {
        this.tracked.set(candidate.id, { lod: candidate.lod, visible: candidate.visible, desired });
        if (desired) {
          this.mountedSet.add(candidate.id);
          added.push(candidate.id);
        }
        continue;
      }

      const visibilityChanged = prior.visible !== candidate.visible;
      const isMounted = this.mountedSet.has(candidate.id);

      prior.lod = candidate.lod;
      prior.visible = candidate.visible;
      prior.desired = desired;

      if (desired === isMounted) {
        delete prior.pendingSince;
        continue;
      }

      // A pan is immediate; a zoom waits out the debounce.
      if (visibilityChanged) {
        delete prior.pendingSince;
        this.commit(candidate.id, desired, added, removed);
        continue;
      }

      if (prior.pendingSince === undefined) {
        prior.pendingSince = now;
        continue;
      }
      if (now - prior.pendingSince >= this.debounceMs) {
        delete prior.pendingSince;
        this.commit(candidate.id, desired, added, removed);
      }
    }

    // Anything that dropped out of the candidate list entirely is gone: it was
    // culled or deleted, neither of which is an LOD crossing.
    for (const id of [...this.tracked.keys()]) {
      if (seen.has(id)) continue;
      this.tracked.delete(id);
      if (this.mountedSet.delete(id)) removed.push(id);
    }

    return { mounted: this.mountedSet, added, removed };
  }

  private commit(id: NodeID, desired: boolean, added: NodeID[], removed: NodeID[]): void {
    if (desired) {
      this.mountedSet.add(id);
      added.push(id);
    } else {
      this.mountedSet.delete(id);
      removed.push(id);
    }
  }

  reset(): void {
    this.tracked.clear();
    this.mountedSet.clear();
  }
}
