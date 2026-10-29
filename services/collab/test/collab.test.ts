/**
 * picasso-collab against a real Postgres and real Hocuspocus clients, each
 * holding canvas-sync's `SyncedCanvas`. COLLAB_PG_URL (or DATAPLANE_PG_URL)
 * names the database; COLLAB_REQUIRE_PG=1 makes its absence a failure, as CI
 * sets it.
 */

import { HocuspocusProvider } from '@hocuspocus/provider';
import { createNode } from '@picasso/canvas-core';
import { SyncedCanvas } from '@picasso/canvas-sync';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/store.js';
import { startCollab, type Collab } from '../src/server.js';

const URL_ = process.env.COLLAB_PG_URL ?? process.env.DATAPLANE_PG_URL;
if (!URL_ && process.env.COLLAB_REQUIRE_PG === '1') throw new Error('COLLAB_REQUIRE_PG is set and no database was given');
const suite = URL_ ? describe : describe.skip;

const users = { pm: { tenant: 'acme' }, analyst: { tenant: 'acme' }, outsider: { tenant: 'globex' } };
const node = (id: string, x = 0) => createNode({ id, kind: 'ChartNode', binding: 'wired', position: { x, y: 0 }, size: { w: 200, h: 140 } });
const until = async (fn: () => boolean, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};

suite('picasso-collab', () => {
  let pool: pg.Pool;
  let schema: string;
  const servers: Collab[] = [];
  const clients: HocuspocusProvider[] = [];

  const start = async (over: Partial<Parameters<typeof startCollab>[0]> = {}) => {
    const c = await startCollab({ pool, schema, users, idleMs: 300, snapshotEveryMs: 1_000, ...over });
    servers.push(c);
    return c;
  };
  const open = async (c: Collab, name: string, user: string) => {
    const canvas = new SyncedCanvas();
    let failed: string | undefined;
    const provider = new HocuspocusProvider({ url: c.url, name, document: canvas.doc, token: user, onAuthenticationFailed: ({ reason }) => { failed = reason; } });
    clients.push(provider);
    await until(() => provider.isSynced || failed !== undefined);
    return { canvas, provider, failed };
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL_ });
    schema = `collab_${Date.now().toString(36)}`;
    await migrate(pool, schema);
  });
  afterAll(async () => {
    for (const p of clients) p.destroy();
    for (const s of servers) await s.destroy().catch(() => {});
    await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await pool.end();
  });

  it('two clients converge through the server, and a restarted server reopens the canvas from Postgres', async () => {
    const c = await start();
    const a = await open(c, 'acme/morning', 'pm');
    const b = await open(c, 'acme/morning', 'analyst');
    a.canvas.addNode(node('rates'));
    b.canvas.addNode(node('nvda', 300));
    // A moves the node B made, once it has arrived.
    await until(() => a.canvas.getNode('nvda') !== undefined);
    a.canvas.moveNode('nvda', { x: 320, y: 40 });
    await until(() => a.canvas.snapshot().nodes.size === 2 && b.canvas.getNode('nvda')?.position.x === 320);
    const before = Y.encodeStateVector(a.canvas.doc);

    a.provider.destroy();
    b.provider.destroy();
    await c.destroy();

    const again = await start();
    const reopened = await open(again, 'acme/morning', 'analyst');
    expect([...reopened.canvas.snapshot().nodes.keys()].sort()).toEqual(['nvda', 'rates']);
    expect(reopened.canvas.getNode('nvda')?.position).toEqual({ x: 320, y: 40 });
    expect(Y.encodeStateVector(reopened.canvas.doc)).toEqual(before);
  });

  it('logs every update once, and a load is the last snapshot plus the log after it', async () => {
    const c = await start({ idleMs: 60_000, snapshotEveryMs: 60_000 });
    const a = await open(c, 'acme/log', 'pm');
    for (let i = 0; i < 5; i += 1) a.canvas.addNode(node(`n${i}`, i * 10));
    await new Promise((r) => setTimeout(r, 300));
    const counts = await c.store.counts('acme/log');
    // Five edits, no snapshot yet: the canvas exists only as its log.
    expect(counts.updates).toBe(5);
    expect(counts.snapshots).toBe(0);
    const loaded = await c.store.load('acme/log');
    expect(loaded.replayed).toBe(5);
    const fromLog = new Y.Doc();
    Y.applyUpdate(fromLog, loaded.state!);
    expect(new SyncedCanvas({ doc: fromLog }).snapshot().nodes.size).toBe(5);

    // Reopening applies the stored state; that is not logged a second time.
    a.provider.destroy();
    await c.destroy();
    const again = await start({ idleMs: 60_000, snapshotEveryMs: 60_000 });
    await open(again, 'acme/log', 'analyst');
    await new Promise((r) => setTimeout(r, 300));
    expect((await again.store.counts('acme/log')).updates).toBe(5);
  });

  it('snapshots at most snapshotEveryMs apart while editing, and once more on idle', async () => {
    const c = await start({ idleMs: 300, snapshotEveryMs: 1_000 });
    const a = await open(c, 'acme/cadence', 'pm');
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 3_500) {
      a.canvas.addNode(node(`k${(i += 1)}`));
      await new Promise((r) => setTimeout(r, 100));
    }
    const duringEditing = { ...c.snapshots };
    await new Promise((r) => setTimeout(r, 800));
    // Continuous edits for 3.5s with a 1s ceiling and a 300ms idle: the idle
    // timer never fires while editing, so the interval does, three times.
    expect(duringEditing.idle).toBe(0);
    expect(duringEditing.interval).toBeGreaterThanOrEqual(3);
    expect(duringEditing.interval).toBeLessThanOrEqual(4);
    expect(c.snapshots.idle).toBe(1);
    const rows = await pool.query(`SELECT reason, through_update FROM ${schema}.snapshots WHERE doc = 'acme/cadence' ORDER BY seq`);
    expect(rows.rows.at(-1).reason).toBe('idle');
    const last = await pool.query(`SELECT max(seq) AS m FROM ${schema}.updates WHERE doc = 'acme/cadence'`);
    expect(Number(rows.rows.at(-1).through_update)).toBe(Number(last.rows[0].m));
  });

  it('a user opens only their own tenant\'s canvases', async () => {
    const c = await start();
    const outsider = await open(c, 'acme/morning', 'outsider');
    expect(outsider.failed).toBeDefined();
    expect(outsider.provider.isSynced).toBe(false);
    expect(outsider.canvas.snapshot().nodes.size).toBe(0);
    const nobody = await open(c, 'acme/morning', 'mallory');
    expect(nobody.failed).toBeDefined();
    const res = await fetch(`${c.server.httpURL}/v1/versions?doc=acme/morning`, { headers: { 'X-Picasso-User': 'outsider' } });
    expect(res.status).toBe(403);
  });

  it('offline edits on both sides merge on reconnect, and the log holds both', async () => {
    const c = await start();
    const a = await open(c, 'acme/offline', 'pm');
    const b = await open(c, 'acme/offline', 'analyst');
    b.provider.disconnect();
    a.canvas.addNode(node('from-a'));
    b.canvas.addNode(node('from-b'));
    await new Promise((r) => setTimeout(r, 200));
    expect(a.canvas.getNode('from-b')).toBeUndefined();
    await b.provider.connect();
    await until(() => a.canvas.getNode('from-b') !== undefined && b.canvas.getNode('from-a') !== undefined);
    const authors = await pool.query(`SELECT DISTINCT author FROM ${schema}.updates WHERE doc = 'acme/offline' ORDER BY author`);
    expect(authors.rows.map((r) => r.author)).toEqual(['analyst', 'pm']);
  });

  it('a named version is immutable, records the datasets its nodes cite, and reproduces the canvas as it was', async () => {
    const c = await start();
    const a = await open(c, 'acme/versions', 'pm');
    a.canvas.addNode(node('rev'));
    a.canvas.addNode(node('px'));
    a.canvas.setProvenance('rev', { datasetSnapshots: { iceberg: 'ice-0801' }, asof: '2024-08-05T09:30:00Z', verified: true });
    a.canvas.setProvenance('px', { datasetSnapshots: { iceberg: 'ice-0801', clickhouse: 'ch-77' }, asof: '2024-08-05T09:30:00Z', verified: true });
    a.canvas.transact(() => a.canvas.doc.getMap('meta').set('asof', '2024-08-05T09:30:00Z'));
    await new Promise((r) => setTimeout(r, 200));

    const post = (name: string, user = 'pm') =>
      fetch(`${c.server.httpURL}/v1/versions?doc=acme/versions&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'X-Picasso-User': user } });
    const created = await post('pre-CPI');
    expect(created.status).toBe(201);
    const info = await created.json();
    expect(info.datasetSnapshots).toEqual({ clickhouse: ['ch-77'], iceberg: ['ice-0801'] });
    expect(info.asof).toBe('2024-08-05T09:30:00Z');
    expect((await post('pre-CPI')).status).toBe(409);

    // The canvas moves on; the version does not.
    a.canvas.removeNode('px');
    a.canvas.addNode(node('later'));
    await new Promise((r) => setTimeout(r, 200));
    const got = await (await fetch(`${c.server.httpURL}/v1/versions/state?doc=acme/versions&name=pre-CPI`, { headers: { 'X-Picasso-User': 'analyst' } })).json();
    const was = new Y.Doc();
    Y.applyUpdate(was, Buffer.from(got.state, 'base64'));
    expect([...new SyncedCanvas({ doc: was }).snapshot().nodes.keys()].sort()).toEqual(['px', 'rev']);

    await expect(pool.query(`UPDATE ${schema}.versions SET name = 'post-CPI'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM ${schema}.versions`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`TRUNCATE ${schema}.versions`)).rejects.toThrow(/append-only/);
  });

  it('the update log cannot be rewritten, and keeps every row for ninety days', async () => {
    await expect(pool.query(`UPDATE ${schema}.updates SET author = 'x'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM ${schema}.updates`)).rejects.toThrow(/younger than 90 days/);
    await expect(pool.query(`TRUNCATE ${schema}.updates`)).rejects.toThrow(/append-only/);
    await pool.query(`INSERT INTO ${schema}.updates (doc, author, at, body) VALUES ('acme/old', 'pm', now() - interval '91 days', '\\x00')`);
    const removed = await pool.query(`DELETE FROM ${schema}.updates WHERE doc = 'acme/old'`);
    expect(removed.rowCount).toBe(1);
  });
});
