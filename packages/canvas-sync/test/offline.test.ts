import { createNode } from '@picasso/canvas-core';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { SyncedCanvas } from '../src/canvas.js';
import { EncryptedStore, MemoryBacking, RecordUnreadable } from '../src/encryptedStore.js';
import { OfflineCanvas } from '../src/offline.js';

const secret = (seed: number) => new Uint8Array(32).map((_, i) => (i * 31 + seed) & 0xff);
const node = (id: string, x = 0) => createNode({ id, kind: 'ChartNode', binding: 'wired', position: { x, y: 0 }, size: { w: 200, h: 140 } });

describe('a canvas kept on the device', () => {
  it('reopens with every edit, local and remote, after the tab is gone', async () => {
    const backing = new MemoryBacking();
    const store = await EncryptedStore.open(backing, secret(1), 'canvas');
    const canvas = new SyncedCanvas();
    const offline = await OfflineCanvas.attach(canvas.doc, store, backing, 'dev/semis');
    canvas.addNode(node('mine'));
    canvas.moveNode('mine', { x: 40, y: 10 });
    // An update arriving from the server is kept too.
    const peer = new SyncedCanvas();
    peer.addNode(node('theirs', 300));
    Y.applyUpdate(canvas.doc, Y.encodeStateAsUpdate(peer.doc), 'remote');
    await offline.flushed();
    expect(offline.recordCount).toBe(3);

    // A new tab: a new document, the same session.
    const reopened = new SyncedCanvas();
    const again = await OfflineCanvas.attach(reopened.doc, await EncryptedStore.open(backing, secret(1), 'canvas'), backing, 'dev/semis');
    expect(again.replayed).toBe(3);
    expect([...reopened.snapshot().nodes.keys()].sort()).toEqual(['mine', 'theirs']);
    expect(reopened.getNode('mine')?.position).toEqual({ x: 40, y: 10 });
    // Replaying is not an edit: nothing new was written.
    await again.flushed();
    expect(again.recordCount).toBe(3);
  });

  it('holds nothing readable on the disk, and nothing a later session can open', async () => {
    const backing = new MemoryBacking();
    const store = await EncryptedStore.open(backing, secret(1), 'canvas');
    const canvas = new SyncedCanvas();
    const offline = await OfflineCanvas.attach(canvas.doc, store, backing, 'dev/semis');
    canvas.addNode(node('position-NVDA-long-10000'));
    await offline.flushed();
    // A record is JSON holding base64, so the ids would not show in the raw
    // bytes even unsealed. Read each one the way an unsealed record would be
    // read, and check the ids are not there either.
    const asIfUnsealed = (r: Uint8Array) => {
      try {
        return new TextDecoder('latin1').decode(Uint8Array.from(atob(JSON.parse(new TextDecoder().decode(r)) as string), (c) => c.charCodeAt(0)));
      } catch {
        return '';
      }
    };
    const raw = await Promise.all((await backing.keys()).map((k) => backing.get(k)));
    const decoded = raw.map((r) => asIfUnsealed(r!)).join('') + raw.map((r) => new TextDecoder('latin1').decode(r)).join('');
    expect(decoded).not.toContain('position-NVDA');
    expect(decoded).not.toContain('ChartNode');
    // The control: an unsealed record of the same update is read by the same
    // helper, and the id is there.
    const unsealed = new TextEncoder().encode(JSON.stringify(btoa(String.fromCharCode(...Y.encodeStateAsUpdate(canvas.doc)))));
    expect(asIfUnsealed(unsealed)).toContain('position-NVDA');
    await expect(OfflineCanvas.attach(new Y.Doc(), await EncryptedStore.open(backing, secret(2), 'canvas'), backing, 'dev/semis')).rejects.toThrow(RecordUnreadable);
  });

  it('compacts past a threshold without losing an edit, and keeps canvases apart', async () => {
    const backing = new MemoryBacking();
    const store = await EncryptedStore.open(backing, secret(1), 'canvas');
    const canvas = new SyncedCanvas();
    const offline = await OfflineCanvas.attach(canvas.doc, store, backing, 'dev/semis', { compactAfter: 10 });
    const other = new SyncedCanvas();
    const otherOffline = await OfflineCanvas.attach(other.doc, store, backing, 'dev/rates', { compactAfter: 10 });
    other.addNode(node('curve'));
    for (let i = 0; i < 25; i += 1) canvas.addNode(node(`n${i}`, i));
    await offline.flushed();
    await otherOffline.flushed();
    // 25 edits with a threshold of 10: compacted twice, so far fewer records than edits.
    expect(offline.recordCount).toBeLessThan(11);
    const reopened = new SyncedCanvas();
    await OfflineCanvas.attach(reopened.doc, store, backing, 'dev/semis');
    expect(reopened.snapshot().nodes.size).toBe(25);
    expect(reopened.getNode('curve')).toBeUndefined();
    const rates = new SyncedCanvas();
    await OfflineCanvas.attach(rates.doc, store, backing, 'dev/rates');
    expect([...rates.snapshot().nodes.keys()]).toEqual(['curve']);
  });

  it('logout leaves the canvas unreadable, or gone', async () => {
    const backing = new MemoryBacking();
    const store = await EncryptedStore.open(backing, secret(1), 'canvas');
    const canvas = new SyncedCanvas();
    const offline = await OfflineCanvas.attach(canvas.doc, store, backing, 'dev/semis');
    canvas.addNode(node('a'));
    await offline.flushed();
    offline.detach();
    await store.lock({ erase: true });
    expect(await backing.keys()).toEqual([]);
  });
});
