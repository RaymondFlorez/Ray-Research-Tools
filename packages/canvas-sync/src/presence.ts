/**
 * Presence (PRD 2.2, 7.3).
 *
 * "Separating ephemeral (hover, selection, viewport) from durable (graph
 * structure) avoids syncing 200 cursor updates per second through the CRDT",
 * with cursor updates "throttled at 20Hz" and 12 concurrent editors per canvas.
 *
 * Presence never enters the document. It rides the awareness channel, which is
 * last-write-wins per client and disappears when the client does — the right
 * semantics for a cursor, and the wrong ones for a node.
 *
 * The throttle here is not a blanket rate limit. A moving cursor is
 * interpolatable and worth suppressing; a selection change or a name change is
 * a discrete event that would look broken if it arrived 50ms late, so those go
 * out immediately. Rate-limiting everything is the mistake that makes
 * collaborative UIs feel laggy in exactly the moments people notice.
 */

import type { NodeID, Vec2 } from '@picasso/canvas-core';

/** PRD 7.3: cursor updates are throttled to 20Hz. */
export const PRESENCE_HZ = 20;
export const PRESENCE_INTERVAL_MS = 1000 / PRESENCE_HZ;

/** A peer that has said nothing for this long is treated as gone. */
export const PRESENCE_TIMEOUT_MS = 15_000;

export interface PresenceState {
  clientId: number;
  name: string;
  color: string;
  /** World-space cursor, absent when the pointer has left the canvas. */
  cursor?: Vec2;
  selection: NodeID[];
  /** What the peer is looking at, for the "jump to" affordance. */
  viewport?: { x: number; y: number; scale: number };
  /** Wall clock of the last update, used to prune the dead. */
  at: number;
}

export type PresencePatch = Partial<Omit<PresenceState, 'clientId' | 'at'>>;

function sameCursor(a: Vec2 | undefined, b: Vec2 | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.x === b.x && a.y === b.y;
}

function sameSelection(a: readonly NodeID[], b: readonly NodeID[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Decides what to publish and when. Returns the state to send, or null to hold.
 *
 * Cursor-only movement is capped at 20Hz. Anything else — a selection change, a
 * viewport jump, the cursor leaving the canvas — is published immediately, and
 * resets the cursor clock so the two do not fight.
 */
export class PresenceThrottle {
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastSent?: PresenceState;
  private pending?: PresenceState;

  constructor(
    private readonly self: { clientId: number; name: string; color: string },
    private readonly intervalMs = PRESENCE_INTERVAL_MS,
  ) {}

  /** Offers a new local state. Returns what should go on the wire, if anything. */
  offer(patch: PresencePatch, now: number): PresenceState | null {
    const next: PresenceState = {
      clientId: this.self.clientId,
      name: patch.name ?? this.lastSent?.name ?? this.self.name,
      color: patch.color ?? this.lastSent?.color ?? this.self.color,
      selection: patch.selection ?? this.lastSent?.selection ?? [],
      at: now,
    };
    const cursor = 'cursor' in patch ? patch.cursor : this.lastSent?.cursor;
    if (cursor !== undefined) next.cursor = cursor;
    const viewport = patch.viewport ?? this.lastSent?.viewport;
    if (viewport !== undefined) next.viewport = viewport;

    const previous = this.lastSent;
    const onlyCursorMoved =
      previous !== undefined &&
      next.cursor !== undefined &&
      previous.cursor !== undefined &&
      !sameCursor(previous.cursor, next.cursor) &&
      sameSelection(previous.selection, next.selection) &&
      previous.name === next.name &&
      previous.color === next.color &&
      previous.viewport?.x === next.viewport?.x &&
      previous.viewport?.y === next.viewport?.y &&
      previous.viewport?.scale === next.viewport?.scale;

    if (onlyCursorMoved && now - this.lastSentAt < this.intervalMs) {
      // Hold the newest position; a stale one is worse than a late one.
      this.pending = next;
      return null;
    }

    delete this.pending;
    this.lastSent = next;
    this.lastSentAt = now;
    return next;
  }

  /**
   * Call on a timer or a frame. Publishes a held cursor position once the
   * interval has passed, so movement that stops mid-throttle still lands.
   */
  flush(now: number): PresenceState | null {
    if (!this.pending || now - this.lastSentAt < this.intervalMs) return null;
    const next = { ...this.pending, at: now };
    delete this.pending;
    this.lastSent = next;
    this.lastSentAt = now;
    return next;
  }

  get current(): PresenceState | undefined {
    return this.lastSent;
  }
}

/** Tracks the peers on a canvas. */
export class PresenceRegistry {
  private readonly peers = new Map<number, PresenceState>();

  constructor(private readonly timeoutMs = PRESENCE_TIMEOUT_MS) {}

  /** Applies a peer's state. Awareness is last-write-wins per client. */
  apply(state: PresenceState): void {
    const existing = this.peers.get(state.clientId);
    // An out-of-order packet must not rewind a peer's position.
    if (existing && existing.at > state.at) return;
    this.peers.set(state.clientId, state);
  }

  remove(clientId: number): void {
    this.peers.delete(clientId);
  }

  /** Peers heard from recently enough to still be here. */
  active(now: number): PresenceState[] {
    return [...this.peers.values()].filter((peer) => now - peer.at <= this.timeoutMs);
  }

  /** Drops peers that have gone quiet. Returns how many were dropped. */
  prune(now: number): number {
    let dropped = 0;
    for (const [clientId, peer] of [...this.peers]) {
      if (now - peer.at > this.timeoutMs) {
        this.peers.delete(clientId);
        dropped += 1;
      }
    }
    return dropped;
  }

  get size(): number {
    return this.peers.size;
  }
}

/** Stable, distinguishable colors for peer cursors. */
const PEER_COLORS = [
  '#c0392b', '#2f7d55', '#3a7bc9', '#8e44ad', '#c9903a',
  '#0f8b8d', '#b1442f', '#5b6ee1', '#7d8f2f', '#a0439a',
  '#3d8a5f', '#d97a2b',
];

export function colorForClient(clientId: number): string {
  const index = Math.abs(clientId) % PEER_COLORS.length;
  return PEER_COLORS[index] as string;
}
