/**
 * What running more than one collaboration process costs, measured.
 *
 * Three set-ups over one database: both clients on one instance, then on two
 * instances, then three instances each with a client on the canvas. One
 * client makes 300 edits, 15ms apart; another times each one's arrival. Every
 * query each instance sends to Postgres while the edits run is counted, with
 * snapshots held off so what is counted is the cost of an update.
 *
 * The figures are printed and recorded in the README; the assertions are
 * the structural ones the design implies (every edit arrives; one query logs
 * and announces an update, and an update small enough to travel in the
 * announcement costs the other instances nothing more) and a generous
 * latency ceiling, since timing on a shared machine varies.
 */

import { HocuspocusProvider } from '@hocuspocus/provider';
import pg from 'pg';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/store.js';
import { startCollab, type Collab } from '../src/server.js';

const URL_ = process.env.COLLAB_PG_URL ?? process.env.DATAPLANE_PG_URL;
if (!URL_ && process.env.COLLAB_REQUIRE_PG === '1') throw new Error('COLLAB_REQUIRE_PG is set and no database was given');
const suite = URL_ ? describe : describe.skip;

const EDITS = 300;
const users = { pm: { tenant: 'acme' }, analyst: { tenant: 'acme' }, loader: { tenant: 'acme' } };
const until = async (fn: () => boolean, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
};
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

suite('what fan-out across processes costs', () => {
  let pool: pg.Pool;
  let schema: string;
  const servers: Collab[] = [];
  const providers: HocuspocusProvider[] = [];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL_ });
    schema = `fanout_${Date.now().toString(36)}`;
    await migrate(pool, schema);
  });
  afterAll(async () => {
    for (const p of providers) p.destroy();
    for (const s of servers) await s.destroy().catch(() => {});
    await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await pool.end();
  });

  /** An instance whose queries are counted. */
  const instance = async () => {
    const counter = { queries: 0 };
    const counted = new Proxy(pool, {
      get(target, prop, receiver) {
        if (prop === 'query') return (...args: unknown[]) => {
          counter.queries += 1;
          return (target.query as (...a: unknown[]) => unknown).apply(target, args);
        };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const c = await startCollab({ pool: counted, schema, users, devIdentity: true, idleMs: 60_000, snapshotEveryMs: 60_000, retentionEveryMs: 0 });
    servers.push(c);
    return { c, counter };
  };
  const client = async (c: Collab, doc: string, user: string) => {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: c.url, name: doc, document: ydoc, token: user });
    providers.push(provider);
    await until(() => provider.isSynced);
    return ydoc;
  };

  const run = async (label: string, layout: number[]) => {
    const doc = `acme/fanout-${label}`;
    const instances: Array<Awaited<ReturnType<typeof instance>>> = [];
    for (let i = 0; i < Math.max(...layout) + 1; i += 1) instances.push(await instance());
    // layout[k] is the instance client k connects to; client 0 writes, client 1 times.
    const docs: Y.Doc[] = [];
    for (const [k, at] of layout.entries()) docs.push(await client(instances[at]!.c, doc, (['pm', 'analyst', 'loader'] as const)[k]!));
    const latencies: number[] = [];
    docs[1]!.getMap('t').observe((e) => {
      const now = performance.now();
      for (const key of e.keysChanged) latencies.push(now - (docs[1]!.getMap('t').get(key) as number));
    });
    await new Promise((r) => setTimeout(r, 300));
    for (const i of instances) i.counter.queries = 0;
    for (let i = 0; i < EDITS; i += 1) {
      docs[0]!.getMap('t').set(String(i), performance.now());
      await new Promise((r) => setTimeout(r, 15));
    }
    await until(() => latencies.length === EDITS && docs.every((d) => d.getMap('t').size === EDITS));
    await new Promise((r) => setTimeout(r, 300));
    const queries = instances.reduce((n, i) => n + i.counter.queries, 0);
    const result = { label, instances: instances.length, p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99), queriesPerUpdate: queries / EDITS };
    console.log(`${label}: ${result.instances} instance(s), arrival p50 ${result.p50.toFixed(1)}ms p95 ${result.p95.toFixed(1)}ms p99 ${result.p99.toFixed(1)}ms, ${result.queriesPerUpdate.toFixed(2)} queries per update`);
    return result;
  };

  it('measures arrival time and database queries per update, one to three instances', async () => {
    const one = await run('one-instance', [0, 0]);
    const two = await run('two-instances', [0, 1]);
    const three = await run('three-instances', [0, 1, 2]);
    // One query logs and announces an update, which carries it to the other instances.
    for (const r of [one, two, three]) expect(r.queriesPerUpdate).toBeCloseTo(1, 2);
    expect(two.p95).toBeLessThan(500);
    expect(three.p95).toBeLessThan(500);
  });

  it('reads an update too large to announce from the log, one query per other instance', async () => {
    const a = await instance();
    const b = await instance();
    const writer = await client(a.c, 'acme/large', 'pm');
    const reader = await client(b.c, 'acme/large', 'analyst');
    a.counter.queries = 0;
    b.counter.queries = 0;
    writer.getText('t').insert(0, 'x'.repeat(20_000));
    await until(() => reader.getText('t').length === 20_000);
    await new Promise((r) => setTimeout(r, 200));
    expect([a.counter.queries, b.counter.queries]).toEqual([1, 1]);
  });
});
