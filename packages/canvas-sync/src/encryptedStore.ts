/**
 * The encrypted offline store (PRD 7.2, "Client-side").
 *
 * > Local IndexedDB persistence is encrypted with a key derived from the
 * > session and dropped on logout.
 *
 * PRD 7.4's fifth rung has the canvas "continue fully offline against
 * IndexedDB", which means positions, marks and analyst notes sitting on a
 * laptop disk. This is what keeps them unreadable there once the session ends.
 *
 * ## What each choice buys, and what it does not
 *
 * **HKDF from a session secret, not from the access token.** The key is
 * derived from a per-session secret the server hands the client at login. The
 * access token would be the convenient input and the wrong one: it is sent on
 * every request, it turns up in proxies and logs, and anything that has seen it
 * could derive the key. The per-store salt means two stores under one session
 * do not share a key.
 *
 * **AES-GCM with a fresh random IV per write.** GCM with a repeated IV under
 * one key leaks the XOR of two plaintexts and the authentication key with it;
 * the IV is drawn from the platform CSPRNG for every write, never counted and
 * never reused, and the test writes a thousand records to check.
 *
 * **The record's key is authenticated with its value.** Ciphertexts are
 * stored under keys, and without binding the two, anyone with write access to
 * the disk can swap the encrypted `position:NVDA` with the encrypted
 * `position:AMD` and both decrypt cleanly. The record key is GCM's additional
 * authenticated data, so a swapped record fails to decrypt instead.
 *
 * **The key is non-extractable.** `exportKey` refuses it, so script running in
 * the page cannot copy the key out. It can still ask the key to decrypt while
 * the session is live — non-extractable limits what an attacker takes away,
 * not what they can do while they are there — and that is stated rather than
 * implied away.
 *
 * **Logout drops the key; it cannot scrub memory.** After `lock()` the store
 * holds no key and every read is refused. JavaScript gives no way to zero the
 * bytes a garbage-collected key once occupied, so "dropped" means unreachable
 * from this code, not erased from RAM. The ciphertext left on disk is
 * unreadable without the session secret, and `lock({ erase: true })` deletes
 * it too for a caller that does not want to leave it.
 */

/** Where ciphertext lives. IndexedDB implements this; the tests use a Map. */
export interface CipherBacking {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export class MemoryBacking implements CipherBacking {
  private readonly map = new Map<string, Uint8Array>();
  async get(key: string) {
    const value = this.map.get(key);
    return value ? value.slice() : undefined;
  }
  async put(key: string, value: Uint8Array) {
    this.map.set(key, value.slice());
  }
  async delete(key: string) {
    this.map.delete(key);
  }
  async keys() {
    return [...this.map.keys()];
  }
}

export class StoreLocked extends Error {
  constructor() {
    super('the offline store is locked: the session that could read it has ended');
    this.name = 'StoreLocked';
  }
}

export class RecordUnreadable extends Error {
  constructor(readonly key: string) {
    super(
      `${key} did not decrypt: it was written under another session, altered on disk, ` +
        'or moved from another key',
    );
    this.name = 'RecordUnreadable';
  }
}

/** Bytes of IV per record, as GCM is specified for. */
export const IV_BYTES = 12;
/** At least this much session secret, or the derivation has nothing to stretch. */
export const MIN_SECRET_BYTES = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A copy on a plain ArrayBuffer, which is what WebCrypto's types accept. */
function bytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(view.length));
  copy.set(view);
  return copy;
}

export class EncryptedStore {
  private key: CryptoKey | undefined;

  private constructor(
    private readonly backing: CipherBacking,
    key: CryptoKey,
  ) {
    this.key = key;
  }

  /**
   * Opens a store under a session.
   *
   * `storeName` salts the derivation, so the canvas cache and the ink cache
   * under one session have different keys and one leaking does not open the
   * other.
   */
  static async open(
    backing: CipherBacking,
    sessionSecret: Uint8Array,
    storeName: string,
  ): Promise<EncryptedStore> {
    if (sessionSecret.length < MIN_SECRET_BYTES) {
      throw new Error(`a session secret needs at least ${MIN_SECRET_BYTES} bytes`);
    }
    const material = await crypto.subtle.importKey('raw', bytes(sessionSecret), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode(`picasso/offline-store/v1/${storeName}`),
        info: encoder.encode('aes-256-gcm record key'),
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    return new EncryptedStore(backing, key);
  }

  get locked(): boolean {
    return this.key === undefined;
  }

  /** The key itself, for the test that it cannot be exported. */
  keyForInspection(): CryptoKey {
    if (!this.key) throw new StoreLocked();
    return this.key;
  }

  async put(recordKey: string, value: unknown): Promise<void> {
    const key = this.require();
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const plaintext = encoder.encode(JSON.stringify(value));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(recordKey) },
        key,
        plaintext,
      ),
    );
    const record = new Uint8Array(IV_BYTES + sealed.length);
    record.set(iv, 0);
    record.set(sealed, IV_BYTES);
    await this.backing.put(recordKey, record);
  }

  async get<T = unknown>(recordKey: string): Promise<T | undefined> {
    const key = this.require();
    const record = await this.backing.get(recordKey);
    if (!record) return undefined;
    if (record.length <= IV_BYTES) throw new RecordUnreadable(recordKey);
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes(record.subarray(0, IV_BYTES)),
          additionalData: encoder.encode(recordKey),
        },
        key,
        bytes(record.subarray(IV_BYTES)),
      );
      return JSON.parse(decoder.decode(plaintext)) as T;
    } catch {
      throw new RecordUnreadable(recordKey);
    }
  }

  async delete(recordKey: string): Promise<void> {
    this.require();
    await this.backing.delete(recordKey);
  }

  /**
   * Logout. The key is dropped and every later call is refused.
   *
   * With `erase`, the ciphertext goes too. Without it, it stays on disk
   * unreadable, which is what lets an offline session that ended by timeout
   * rather than by choice be resumed under the same session secret.
   */
  async lock(options: { erase?: boolean } = {}): Promise<void> {
    this.key = undefined;
    if (options.erase) {
      for (const key of await this.backing.keys()) await this.backing.delete(key);
    }
  }

  private require(): CryptoKey {
    if (!this.key) throw new StoreLocked();
    return this.key;
  }
}
