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
import { createServer } from 'node:http';
import { SessionIssuer } from '@picasso/auth';
import { CanvasStore, migrate } from '../src/store.js';
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
    const c = await startCollab({ pool, schema, users, devIdentity: true, idleMs: 300, snapshotEveryMs: 1_000, ...over });
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

  it('the retention job removes what ninety days no longer require, and every canvas opens the same', async () => {
    const store = new CanvasStore(pool, schema);
    // Real Yjs updates, one per edit, as a client sends them.
    const edits = (doc: string, n: number) => {
      const y = new Y.Doc();
      const out: Uint8Array[] = [];
      y.on('update', (u: Uint8Array) => out.push(u));
      for (let i = 0; i < n; i += 1) y.getMap('nodes').set(`${doc}-${i}`, i);
      return { y, out };
    };
    const put = async (doc: string, body: Uint8Array, daysAgo: number) =>
      Number((await pool.query<{ seq: string }>(`INSERT INTO ${schema}.updates (doc, author, at, body) VALUES ($1, 'pm', now() - make_interval(days => $2), $3) RETURNING seq`, [doc, daysAgo, Buffer.from(body)])).rows[0]!.seq);
    const snap = async (doc: string, state: Uint8Array, through: number, daysAgo: number) =>
      pool.query(`INSERT INTO ${schema}.snapshots (doc, at, through_update, reason, state) VALUES ($1, now() - make_interval(days => $2), $3, 'test', $4)`, [doc, daysAgo, through, Buffer.from(state)]);
    const opened = async (doc: string) => {
      const y = new Y.Doc();
      Y.applyUpdate(y, (await store.load(doc)).state!);
      return y.getMap('nodes').toJSON();
    };

    // A: five updates, three past ninety days; an old snapshot through the
    // second, the latest (also old) through the third.
    const a = edits('acme/ret-a', 5);
    const seqA = [];
    for (const [i, u] of a.out.entries()) seqA.push(await put('acme/ret-a', u, i < 3 ? 100 : 10));
    const partial = new Y.Doc();
    Y.applyUpdate(partial, a.out[0]!);
    Y.applyUpdate(partial, a.out[1]!);
    await snap('acme/ret-a', Y.encodeStateAsUpdate(partial), seqA[1]!, 95);
    Y.applyUpdate(partial, a.out[2]!);
    await snap('acme/ret-a', Y.encodeStateAsUpdate(partial), seqA[2]!, 91);
    // B: three updates, all past ninety days, never snapshotted.
    const b = edits('acme/ret-b', 3);
    for (const u of b.out) await put('acme/ret-b', u, 120);
    // C: recent only.
    const c = edits('acme/ret-c', 2);
    for (const u of c.out) await put('acme/ret-c', u, 1);

    const before = { a: await opened('acme/ret-a'), b: await opened('acme/ret-b'), c: await opened('acme/ret-c') };
    expect(before.a).toEqual(a.y.getMap('nodes').toJSON());
    // Deleting alone takes nothing B needs: no snapshot includes its updates yet.
    expect(await store.prune()).toEqual({ updates: 3, snapshots: 1 });
    expect(await store.counts('acme/ret-b')).toMatchObject({ updates: 3, snapshots: 0 });
    expect({ a: await opened('acme/ret-a'), b: await opened('acme/ret-b'), c: await opened('acme/ret-c') }).toEqual(before);
    const r = await store.retain();
    expect(r).toEqual({ snapshotted: 1, updates: 3, snapshots: 0 });
    expect({ a: await opened('acme/ret-a'), b: await opened('acme/ret-b'), c: await opened('acme/ret-c') }).toEqual(before);
    expect(await store.counts('acme/ret-a')).toMatchObject({ updates: 2, snapshots: 1 });
    expect(await store.counts('acme/ret-b')).toMatchObject({ updates: 0, snapshots: 1 });
    expect(await store.counts('acme/ret-c')).toMatchObject({ updates: 2, snapshots: 0 });
    // Nothing left to do: a second run changes nothing.
    expect(await store.retain()).toEqual({ snapshotted: 0, updates: 0, snapshots: 0 });
  });

  it('hands every tab of a session the same secret, and never an ended session\'s', async () => {
    const c = await start();
    const session = async (user: string) => {
      const res = await fetch(`${c.server.httpURL}/v1/session`, { method: 'POST', headers: { 'X-Picasso-User': user } });
      return res.ok ? ((await res.json()) as { secret: string }).secret : res.status;
    };
    const first = await session('pm');
    expect(typeof first === 'string' && Buffer.from(first, 'base64').length === 32).toBe(true);
    expect(await session('pm')).toBe(first);
    expect(await session('analyst')).not.toBe(first);
    expect(await session('mallory')).toBe(403);
    const out = await fetch(`${c.server.httpURL}/v1/logout`, { method: 'POST', headers: { 'X-Picasso-User': 'pm' } });
    expect(await out.json()).toEqual({ ended: true });
    const next = await session('pm');
    expect(next).not.toBe(first);
    const reuse = await pool.query(`SELECT count(*) AS n FROM ${schema}.sessions WHERE "user" = 'pm' AND ended IS NULL`);
    expect(Number(reuse.rows[0].n)).toBe(1);
  });

  it('without devIdentity, only picasso-auth\'s session token opens a canvas', async () => {
    // picasso-auth's issuer, with its key set served where the collab server will look.
    let jwks: unknown;
    const keyServer = createServer((req, res) =>
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.url === '/auth/revoked' ? { sids: issuer.revoked() } : jwks)));
    await new Promise<void>((r) => keyServer.listen(0, '127.0.0.1', () => r()));
    const authUrl = `http://127.0.0.1:${(keyServer.address() as { port: number }).port}`;
    const issuer = await SessionIssuer.create({ issuer: authUrl, tenants: { acme: { holdsPositions: true }, globex: { holdsPositions: false } } });
    jwks = issuer.jwks();
    const c = await startCollab({ pool, schema, users, authUrl, idleMs: 300, snapshotEveryMs: 1_000, revocationRefreshMs: 200 });
    servers.push(c);
    const token = async (user: string, tenant: string) => (await issuer.mint(user, tenant, { authTime: Date.now(), amr: ['pwd', 'otp'] })).token;

    const signedIn = await open(c, 'acme/tokens', await token('pm', 'acme'));
    expect(signedIn.failed).toBeUndefined();
    expect(signedIn.provider.isSynced).toBe(true);
    const named = await open(c, 'acme/tokens', 'pm');
    expect(named.failed).toBeDefined();
    // A valid token whose tenant is not the user's own.
    const elsewhere = await open(c, 'acme/tokens', await token('pm', 'globex'));
    expect(elsewhere.failed).toBeDefined();
    const res = await fetch(`${c.server.httpURL}/v1/session`, { method: 'POST', headers: { 'X-Picasso-User': 'pm' } });
    expect(res.status).toBe(403);
    const live = await issuer.mint('pm', 'acme', { authTime: Date.now(), amr: ['pwd', 'otp'] });
    const session = () => fetch(`${c.server.httpURL}/v1/session`, { method: 'POST', headers: { authorization: `Bearer ${live.token}` } });
    expect((await session()).status).toBe(200);
    // Logged out at picasso-auth: the same, unexpired token is refused here once the list is re-read.
    issuer.end(live.session.sid);
    await new Promise((r) => setTimeout(r, 250));
    expect((await session()).status).toBe(403);
    expect((await open(c, 'acme/tokens', live.token)).failed).toBeDefined();
    keyServer.close();
  });
});
