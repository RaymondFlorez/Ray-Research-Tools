import { describe, expect, it } from 'vitest';
import {
  EncryptedStore,
  IV_BYTES,
  MemoryBacking,
  RecordUnreadable,
  StoreLocked,
} from '../src/encryptedStore.js';

function secret(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

const position = { instrument: 'eq:nvda:us', quantity: 12450, basis: 812.4 };

describe('the offline store', () => {
  it('reads back what it wrote', async () => {
    const store = await EncryptedStore.open(new MemoryBacking(), secret(7), 'canvas');
    await store.put('position:NVDA', position);
    expect(await store.get('position:NVDA')).toEqual(position);
    expect(await store.get('position:missing')).toBeUndefined();
  });

  it('puts nothing readable on disk', async () => {
    const backing = new MemoryBacking();
    const store = await EncryptedStore.open(backing, secret(7), 'canvas');
    await store.put('position:NVDA', position);
    const raw = new TextDecoder('latin1').decode((await backing.get('position:NVDA'))!);
    for (const fragment of ['12450', 'nvda', '812.4', 'quantity']) {
      expect(raw.toLowerCase()).not.toContain(fragment);
    }
  });

  it('never reuses an IV across a thousand writes', async () => {
    const backing = new MemoryBacking();
    const store = await EncryptedStore.open(backing, secret(7), 'canvas');
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      await store.put('position:NVDA', position);
      const iv = Array.from((await backing.get('position:NVDA'))!.subarray(0, IV_BYTES)).join(',');
      expect(seen.has(iv)).toBe(false);
      seen.add(iv);
    }
  });

  it('refuses a record moved to another key', async () => {
    // Without the key bound into the ciphertext, whoever can write the disk
    // can swap two positions and both decrypt cleanly.
    const backing = new MemoryBacking();
    const store = await EncryptedStore.open(backing, secret(7), 'canvas');
    await store.put('position:NVDA', position);
    await store.put('position:AMD', { ...position, instrument: 'eq:amd:us', quantity: 30 });
    const nvda = (await backing.get('position:NVDA'))!;
    const amd = (await backing.get('position:AMD'))!;
    await backing.put('position:NVDA', amd);
    await backing.put('position:AMD', nvda);
    await expect(store.get('position:NVDA')).rejects.toThrow(RecordUnreadable);
    await expect(store.get('position:AMD')).rejects.toThrow(RecordUnreadable);
  });

  it('refuses a record altered on disk by a single bit', async () => {
    const backing = new MemoryBacking();
    const store = await EncryptedStore.open(backing, secret(7), 'canvas');
    await store.put('position:NVDA', position);
    const record = (await backing.get('position:NVDA'))!;
    record[IV_BYTES + 3]! ^= 1;
    await backing.put('position:NVDA', record);
    await expect(store.get('position:NVDA')).rejects.toThrow(RecordUnreadable);
  });

  it('holds a key that cannot be exported', async () => {
    const store = await EncryptedStore.open(new MemoryBacking(), secret(7), 'canvas');
    const key = store.keyForInspection();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('refuses a secret too short to derive from', async () => {
    await expect(EncryptedStore.open(new MemoryBacking(), new Uint8Array(16), 'canvas')).rejects.toThrow(
      /32 bytes/,
    );
  });
});

describe('logout', () => {
  it('drops the key, and every later call is refused', async () => {
    const store = await EncryptedStore.open(new MemoryBacking(), secret(7), 'canvas');
    await store.put('position:NVDA', position);
    await store.lock();
    expect(store.locked).toBe(true);
    await expect(store.get('position:NVDA')).rejects.toThrow(StoreLocked);
    await expect(store.put('position:NVDA', position)).rejects.toThrow(StoreLocked);
    expect(() => store.keyForInspection()).toThrow(StoreLocked);
  });

  it('leaves ciphertext that the next session cannot read', async () => {
    const backing = new MemoryBacking();
    const first = await EncryptedStore.open(backing, secret(7), 'canvas');
    await first.put('position:NVDA', position);
    await first.lock();
    const next = await EncryptedStore.open(backing, secret(8), 'canvas');
    await expect(next.get('position:NVDA')).rejects.toThrow(RecordUnreadable);
    // The same session secret reopens it, which is what lets a session that
    // timed out offline resume without losing its work.
    const same = await EncryptedStore.open(backing, secret(7), 'canvas');
    expect(await same.get('position:NVDA')).toEqual(position);
  });

  it('erases the ciphertext too, when asked', async () => {
    const backing = new MemoryBacking();
    const store = await EncryptedStore.open(backing, secret(7), 'canvas');
    await store.put('position:NVDA', position);
    await store.lock({ erase: true });
    expect(await backing.keys()).toEqual([]);
  });

  it('gives two stores under one session two keys', async () => {
    const backing = new MemoryBacking();
    const canvas = await EncryptedStore.open(backing, secret(7), 'canvas');
    await canvas.put('shared-key', position);
    const ink = await EncryptedStore.open(backing, secret(7), 'ink');
    await expect(ink.get('shared-key')).rejects.toThrow(RecordUnreadable);
  });
});
