/**
 * A canvas kept on the device, sealed (PRD 2.2, 7.2, 7.4).
 *
 * > Collab server unreachable → canvas continues fully offline against
 * > IndexedDB; edits merge on reconnect via CRDT.
 * > Local IndexedDB persistence is encrypted with a key derived from the
 * > session and dropped on logout.
 *
 * y-indexeddb, the PRD's named choice, writes Yjs updates to IndexedDB in the
 * clear, and the second sentence rules that out. So this is the same idea
 * through `EncryptedStore`: every update to the document — local edits and
 * what arrives from the server alike — is sealed and written as its own record
 * the moment it happens, and opening the canvas replays the records in order.
 *
 * **One record per update, written at once.** A tab can close between any two
 * edits, and an IndexedDB write started before it does is far more likely to
 * land than one deferred to a timer or to `pagehide`. Writing the whole state
 * each time would also do, at a cost that grows with the canvas; an update is
 * as small as the edit.
 *
 * **Compaction never leaves a gap.** Past `compactAfter` records, the merged
 * state is written as a new record first, and only then are the older ones
 * deleted. A crash between the two leaves both, and replaying both is harmless
 * because a Yjs update applies idempotently.
 *
 * **What it cannot do** is open the canvas without the session secret, which
 * comes from the server. A tab reopened while still offline has the sealed
 * records and no key to read them; they are read, and sent, once the session
 * is reachable again. Nothing here caches the secret, because a key on the
 * same disk as the ciphertext would make the encryption decorative.
 */

import * as Y from 'yjs';
import type { CipherBacking, EncryptedStore } from './encryptedStore.js';

/** The origin of updates replayed from the device, so they are not written back. */
export const OFFLINE_ORIGIN = 'offline-store';

const SEQ_DIGITS = 12;

function toBase64(update: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < update.length; i += 0x8000) binary += String.fromCharCode(...update.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export interface OfflineOptions {
  /** Records past which the canvas's updates are merged into one. */
  compactAfter?: number;
}

export class OfflineCanvas {
  private seq = 0;
  private records = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly onUpdate: (update: Uint8Array, origin: unknown) => void;

  private constructor(
    readonly doc: Y.Doc,
    private readonly store: EncryptedStore,
    private readonly backing: CipherBacking,
    private readonly name: string,
    private readonly compactAfter: number,
    /** Records replayed when the canvas was opened. */
    readonly replayed: number,
  ) {
    this.onUpdate = (update, origin) => {
      if (origin === OFFLINE_ORIGIN) return;
      this.enqueue(async () => {
        await this.write(update);
        if (this.records > this.compactAfter) await this.compact();
      });
    };
    doc.on('update', this.onUpdate);
  }

  /**
   * Replays what the device holds for `name` into `doc`, then keeps every
   * later update. `backing` is the store's own, for listing records.
   */
  static async attach(doc: Y.Doc, store: EncryptedStore, backing: CipherBacking, name: string, options: OfflineOptions = {}): Promise<OfflineCanvas> {
    if (name.includes('#')) throw new Error(`a canvas name may not contain "#": ${name}`);
    const keys = (await backing.keys()).filter((k) => k.startsWith(`${name}#`)).sort();
    const updates: Uint8Array[] = [];
    for (const key of keys) {
      const text = await store.get<string>(key);
      if (text !== undefined) updates.push(fromBase64(text));
    }
    if (updates.length > 0) {
      doc.transact(() => {
        for (const u of updates) Y.applyUpdate(doc, u, OFFLINE_ORIGIN);
      }, OFFLINE_ORIGIN);
    }
    const offline = new OfflineCanvas(doc, store, backing, name, options.compactAfter ?? 200, updates.length);
    const last = keys.at(-1);
    offline.seq = last ? Number(last.slice(name.length + 1)) : 0;
    offline.records = keys.length;
    return offline;
  }

  /** Waits for every write started so far. */
  flushed(): Promise<void> {
    return this.chain;
  }

  get recordCount(): number {
    return this.records;
  }

  /** Stops writing. What is on the device stays. */
  detach(): void {
    this.doc.off('update', this.onUpdate);
  }

  private enqueue(step: () => Promise<void>): void {
    this.chain = this.chain.then(step).catch((err) => {
      console.error(`offline store for ${this.name}: ${(err as Error).message}`);
    });
  }

  private key(seq: number): string {
    return `${this.name}#${String(seq).padStart(SEQ_DIGITS, '0')}`;
  }

  private async write(update: Uint8Array): Promise<void> {
    this.seq += 1;
    this.records += 1;
    await this.store.put(this.key(this.seq), toBase64(update));
  }

  /** Writes the merged state, then deletes what it replaces. */
  private async compact(): Promise<void> {
    const older = (await this.backing.keys()).filter((k) => k.startsWith(`${this.name}#`)).sort();
    await this.write(Y.encodeStateAsUpdate(this.doc));
    for (const key of older) await this.backing.delete(key);
    this.records -= older.length;
  }
}

/** IndexedDB under `CipherBacking`: one object store of sealed records. */
export class IndexedDbBacking implements CipherBacking {
  private constructor(private readonly db: IDBDatabase) {}

  static open(database: string): Promise<IndexedDbBacking> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(database, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('records');
      req.onsuccess = () => resolve(new IndexedDbBacking(req.result));
      req.onerror = () => reject(req.error);
    });
  }

  private run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('records', mode);
      const req = op(tx.objectStore('records'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const v = await this.run('readonly', (s) => s.get(key) as IDBRequest<Uint8Array | undefined>);
    return v === undefined ? undefined : new Uint8Array(v);
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    await this.run('readwrite', (s) => s.put(value.slice(), key));
  }

  async delete(key: string): Promise<void> {
    await this.run('readwrite', (s) => s.delete(key));
  }

  async keys(): Promise<string[]> {
    return (await this.run('readonly', (s) => s.getAllKeys())).map(String);
  }

  close(): void {
    this.db.close();
  }
}
