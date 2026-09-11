/**
 * Transport and offline behaviour (PRD 7.4, degradation step 5).
 *
 * "Collab server unreachable → canvas continues fully offline against
 * IndexedDB; edits merge on reconnect via CRDT."
 *
 * That guarantee is the whole reason the document is a CRDT rather than a
 * lock-server model, and it needs no queue or replay log: a peer that has been
 * away sends its state vector, receives exactly the updates it is missing, and
 * converges. This module is that exchange, plus a `Link` and a `Room` that model
 * a real connection going down and coming back, so the behaviour can be tested
 * rather than assumed.
 */

import * as Y from 'yjs';
import { REMOTE_ORIGIN } from './canvas.js';

export function stateVector(doc: Y.Doc): Uint8Array {
  return Y.encodeStateVector(doc);
}

/** Everything `doc` has that a peer at `vector` does not. */
export function diffSince(doc: Y.Doc, vector: Uint8Array): Uint8Array {
  return Y.encodeStateAsUpdate(doc, vector);
}

export function applyRemote(doc: Y.Doc, update: Uint8Array, origin: unknown = REMOTE_ORIGIN): void {
  Y.applyUpdate(doc, update, origin);
}

/** One-way catch-up: gives `to` everything `from` has that it is missing. */
export function catchUpOneWay(from: Y.Doc, to: Y.Doc): void {
  applyRemote(to, diffSince(from, stateVector(to)));
}

/** Two-way catch-up, which is what a reconnect actually is. */
export function catchUp(a: Y.Doc, b: Y.Doc): void {
  const vectorA = stateVector(a);
  const vectorB = stateVector(b);
  applyRemote(b, diffSince(a, vectorB));
  applyRemote(a, diffSince(b, vectorA));
}

/**
 * A live link between two documents.
 *
 * While connected, updates flow both ways as they happen. While disconnected,
 * both sides keep editing locally and nothing is buffered — on reconnect the
 * state-vector exchange works out what each side missed, which is exactly how
 * the real Hocuspocus connection behaves.
 */
export class Link {
  private connected = false;
  private detachA?: () => void;
  private detachB?: () => void;

  constructor(
    private readonly a: Y.Doc,
    private readonly b: Y.Doc,
    options: { connect?: boolean } = {},
  ) {
    if (options.connect !== false) this.connect();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    if (this.connected) return;
    // Reconcile first: everything missed while the link was down.
    catchUp(this.a, this.b);

    const forward = (source: Y.Doc, target: Y.Doc): (() => void) => {
      const handler = (update: Uint8Array, origin: unknown): void => {
        // Do not echo back what just arrived from the other side.
        if (origin === REMOTE_ORIGIN) return;
        applyRemote(target, update);
      };
      source.on('update', handler);
      return () => source.off('update', handler);
    };

    this.detachA = forward(this.a, this.b);
    this.detachB = forward(this.b, this.a);
    this.connected = true;
  }

  disconnect(): void {
    this.detachA?.();
    this.detachB?.();
    delete this.detachA;
    delete this.detachB;
    this.connected = false;
  }
}

/**
 * A hub of documents, as a collab server room is. Every peer sees every other
 * peer's updates; a peer can drop out and rejoin without losing its own work.
 */
export class Room {
  private readonly peers = new Map<Y.Doc, { detach?: () => void; online: boolean }>();

  join(doc: Y.Doc): void {
    if (this.peers.has(doc)) return;
    this.peers.set(doc, { online: false });
    this.setOnline(doc, true);
  }

  leave(doc: Y.Doc): void {
    this.setOnline(doc, false);
    this.peers.delete(doc);
  }

  setOnline(doc: Y.Doc, online: boolean): void {
    const peer = this.peers.get(doc);
    if (!peer || peer.online === online) return;

    if (!online) {
      peer.detach?.();
      delete peer.detach;
      peer.online = false;
      return;
    }

    // Reconcile with everyone already in the room, then start streaming.
    for (const [other, state] of this.peers) {
      if (other === doc || !state.online) continue;
      catchUp(doc, other);
    }

    const handler = (update: Uint8Array, origin: unknown): void => {
      if (origin === REMOTE_ORIGIN) return;
      for (const [other, state] of this.peers) {
        if (other === doc || !state.online) continue;
        applyRemote(other, update);
      }
    };
    doc.on('update', handler);
    peer.detach = () => doc.off('update', handler);
    peer.online = true;
  }

  get size(): number {
    return this.peers.size;
  }

  destroy(): void {
    for (const doc of [...this.peers.keys()]) this.leave(doc);
  }
}
