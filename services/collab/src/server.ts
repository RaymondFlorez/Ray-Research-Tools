/**
 * picasso-collab (PRD 2.3): Yjs document sync over Hocuspocus, with the
 * canvas kept in Postgres (`store.ts`).
 *
 * The server holds a canvas only while someone has it open. Every update a
 * client sends is appended to the log as it arrives; the merged state is
 * snapshotted at most `snapshotEveryMs` apart while anyone is editing (thirty
 * seconds, the PRD's figure) and again once edits stop for `idleMs`.
 *
 * Two rules enforced here:
 *
 *   - **A canvas belongs to a tenant.** A document is named
 *     `<tenant>/<canvas>`, and a user may open only their own tenant's. The
 *     tenant comes from the user, never from the request.
 *   - **A version's dataset snapshots come from the canvas, not the caller.**
 *     Every node carries the dataset snapshot ids it was computed against in
 *     its synced provenance; a version records what the state says, so it
 *     cannot claim data it was not computed on.
 *
 * The stored state applied on load is tagged, and an update carrying the tag
 * is not logged. Hocuspocus 4.7.1 does not call `onChange` for what
 * `onLoadDocument` applies — measured: with the check removed, a canvas of
 * five edits still has five log rows after a reopen — so the tag is a guard
 * against that changing, not a fix for something seen.
 */

import { Server, type Connection, type Extension, type onRequestPayload } from '@hocuspocus/server';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { REVOCATION_REFRESH_MS, RevocationList, SESSION_COOKIE, verifySessionToken } from '@picasso/auth';
import { metaOf, nodesOf } from '@picasso/canvas-sync';
import { createRemoteJWKSet } from 'jose';
import * as Y from 'yjs';
import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { buildBundle, bundlePdf, ExportWouldLeak, UnreproducibleExport, type ExportCell, type VendorPolicy } from '@picasso/canvas-guard';
import { checkPurpose, traceId, type AuditStore } from './audit.js';
import { CanvasStore, VersionExists } from './store.js';

/** A request body, refused past `limit` bytes. */
function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`larger than ${limit} bytes`));
        request.destroy();
      } else chunks.push(c);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** The tenant a user belongs to, as the data plane's users file has it. */
export type Users = Readonly<Record<string, { tenant: string }>>;

export interface CollabOptions {
  pool: pg.Pool;
  schema: string;
  users: Users;
  /** picasso-auth's URL: session tokens are verified against the keys it publishes. */
  authUrl?: string;
  /**
   * Accept a user's name as their identity — the provider's token, or
   * X-Picasso-User over HTTP — for development. Off unless asked for.
   */
  devIdentity?: boolean;
  port?: number;
  address?: string;
  /** Longest gap between snapshots while a canvas is being edited. */
  snapshotEveryMs?: number;
  /** Quiet time after which a canvas is snapshotted. */
  idleMs?: number;
  /** How often picasso-auth's list of logged-out sessions is re-read; @picasso/auth's default otherwise. */
  revocationRefreshMs?: number;
  /** How often idle connections are swept against that list; the refresh interval otherwise. */
  sweepEveryMs?: number;
  /**
   * PRD 7.2's audit trail, which every export is written to before it is
   * handed back. Absent, every export is refused.
   */
  audit?: AuditStore;
  /**
   * PRD 7.2: "Exports strip or blur non-redistributable vendor data according
   * to per-vendor rules encoded in the export service." These are those rules.
   * A licensed figure from a vendor with no rule here is withheld.
   */
  vendorPolicies?: readonly VendorPolicy[];
  /**
   * How often the retention job runs (`CanvasStore.retain`): six hours by
   * default, the first run a minute after start so a server restarted more
   * often still runs it. 0 turns it off.
   */
  retentionEveryMs?: number;
}

interface Context {
  user: string;
  tenant: string;
  /** The session the connection was opened under, when it came with a token. */
  sid?: string;
}

const LOADED = Symbol('loaded from the store');
/** An update another instance logged, applied here: already in the log, so not logged again. */
const FANNED_IN = Symbol('from another instance');

/** Splits `tenant/canvas`, refusing anything else. */
export function parseDocName(name: string): { tenant: string; canvas: string } {
  const m = /^([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_.-]{1,128})$/.exec(name);
  if (!m) throw new Error(`a canvas is named tenant/canvas, not ${JSON.stringify(name)}`);
  return { tenant: m[1]!, canvas: m[2]! };
}

/** source -> every dataset snapshot id the canvas's nodes cite, sorted. */
export function datasetSnapshotsOf(doc: Y.Doc): Record<string, string[]> {
  const out = new Map<string, Set<string>>();
  for (const node of nodesOf(doc).values()) {
    const prov = node.get('provenance') as { datasetSnapshots?: Record<string, string> } | undefined;
    for (const [source, id] of Object.entries(prov?.datasetSnapshots ?? {})) {
      if (!out.has(source)) out.set(source, new Set());
      out.get(source)!.add(id);
    }
  }
  return Object.fromEntries([...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([s, ids]) => [s, [...ids].sort()]));
}

export interface Collab {
  server: Server<Context>;
  store: CanvasStore;
  url: string;
  /** Snapshots taken, by reason, since start. */
  snapshots: { interval: number; idle: number };
  /** Updates other instances logged that this one applied to an open canvas. */
  fannedIn: { count: number };
  /** Times the fan-out listener lost its connection and came back. */
  reconnects: { count: number };
  destroy(): Promise<void>;
}

export async function startCollab(o: CollabOptions): Promise<Collab> {
  const store = new CanvasStore(o.pool, o.schema);
  const snapshotEveryMs = o.snapshotEveryMs ?? 30_000;
  const idleMs = o.idleMs ?? 2_000;
  /**
   * Per open canvas: the position through which this instance's copy holds
   * every logged update with no gap (what a snapshot may claim), and the
   * positions it holds beyond that. Its own appends, what it hears from other
   * instances, and what it catches up on all land in `beyond` until the log
   * shows nothing missing before them.
   */
  const watermark = new Map<string, number>();
  const beyond = new Map<string, Set<number>>();
  const held = (doc: string, seq: number) => {
    let set = beyond.get(doc);
    if (!set) beyond.set(doc, (set = new Set()));
    if (seq > (watermark.get(doc) ?? 0)) set.add(seq);
  };
  /** Moves the watermark past every position this copy holds, stopping at the first it does not. */
  const advance = async (doc: string): Promise<number> => {
    let w = watermark.get(doc) ?? 0;
    const set = beyond.get(doc) ?? new Set<number>();
    for (const seq of await store.positionsAfter(doc, w)) {
      if (!set.has(seq)) break;
      set.delete(seq);
      w = seq;
    }
    watermark.set(doc, w);
    return w;
  };
  const lastChange = new Map<string, number>();
  const pending = new Map<string, Promise<unknown>>();
  const counts = { interval: 0, idle: 0 };
  const instanceId = randomUUID();
  const fannedIn = { count: 0 };
  const reconnects = { count: 0 };

  if (!o.authUrl && !o.devIdentity) throw new Error('authUrl is required: callers are identified by picasso-auth\'s session tokens (or devIdentity, for development)');
  const authBase = o.authUrl?.replace(/\/$/, '');
  const keys = authBase ? createRemoteJWKSet(new URL(`${authBase}/.well-known/jwks.json`)) : undefined;
  const revocations = authBase
    ? new RevocationList(`${authBase}/auth/revoked`, o.revocationRefreshMs !== undefined ? { refreshMs: o.revocationRefreshMs } : {})
    : undefined;

  /**
   * Who is asking: a verified session token — the provider's token, the
   * bearer header, or the session cookie a browser sends with its WebSocket —
   * or, only with devIdentity and no token, a user's name.
   */
  const identify = async (token: string | undefined, devName: string | undefined): Promise<{ user: string; tenant?: string; sid?: string }> => {
    if (token && token.split('.').length === 3 && keys && authBase && revocations) {
      const v = await verifySessionToken(token, keys, { issuer: authBase, revoked: await revocations.current() });
      if (!v.ok) throw new Error(`session: ${v.reason}: ${v.message}`);
      return { user: v.session.user, tenant: v.session.tenant, sid: v.session.sid };
    }
    if (o.devIdentity && devName) return { user: devName };
    throw new Error('sign in: no session token');
  };
  const authenticate = (who: { user: string; tenant?: string; sid?: string }, docName: string): Context => {
    const entry = o.users[who.user];
    if (!entry) throw new Error('unknown user');
    if (who.tenant !== undefined && who.tenant !== entry.tenant) throw new Error('the session is for another tenant');
    if (parseDocName(docName).tenant !== entry.tenant) throw new Error(`${who.user} may not open another tenant's canvas`);
    return { user: who.user, tenant: entry.tenant, ...(who.sid ? { sid: who.sid } : {}) };
  };

  /**
   * A WebSocket outlives the token that opened it. Two checks keep the rule
   * for a new connection true of an open one. Every message is checked
   * against the revocation list before it is applied, so nothing a
   * logged-out session sends lands once this service's copy of the list
   * knows. And every connection is held under its session and swept on the
   * list's interval, so an idle one is closed too, and stops receiving.
   * A list that cannot be read closes them all.
   */
  const ended = async (sid: string | undefined): Promise<string | undefined> => {
    if (!sid || !revocations) return undefined;
    const revoked = await revocations.current();
    if (revoked === 'unknown') return 'the session cannot be checked: picasso-auth is unreachable';
    return revoked.has(sid) ? 'the session was logged out' : undefined;
  };
  const open = new Map<string, Set<Connection<Context>>>();
  const sweepEveryMs = o.sweepEveryMs ?? o.revocationRefreshMs ?? REVOCATION_REFRESH_MS;
  let sweeping = false;
  const sweep = async () => {
    if (!revocations || open.size === 0 || sweeping) return;
    sweeping = true;
    try {
      const revoked = await revocations.current();
      for (const [sid, connections] of open) {
        if (revoked !== 'unknown' && !revoked.has(sid)) continue;
        const reason = revoked === 'unknown' ? 'the session cannot be checked: picasso-auth is unreachable' : 'the session was logged out';
        for (const c of connections) c.close({ code: 4401, reason });
        open.delete(sid);
      }
    } finally {
      sweeping = false;
    }
  };
  const sweeper = authBase ? setInterval(() => void sweep(), sweepEveryMs).unref() : undefined;
  const cookieToken = (header: string | null | undefined) =>
    (header ?? '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  const httpToken = (h: IncomingHttpHeaders) => {
    const auth = String(h.authorization ?? '');
    return auth.startsWith('Bearer ') ? auth.slice(7) : cookieToken(h.cookie);
  };

  /**
   * The export service (PRD 2.3's `export-service`, 7.2's "every export").
   *
   * The figures are computed in the browser, since computation does not
   * sync, so the client sends the cells. This is the sanctioned path for
   * them to leave: canvas-guard's `buildBundle` applies the vendor rules held
   * here, refuses position or MNPI-risk data leaving the tenant, and refuses
   * a cell with nothing to reproduce it from. The record goes on the audit
   * trail before the bundle is returned, and a trail that cannot be written
   * means no bundle. A refused export is recorded too, as refused.
   */
  const exportBundle = async (
    request: IncomingMessage,
    ctx: Context,
    doc: string,
    send: (status: number, body: unknown) => void,
    pdf: ((bytes: Uint8Array, trace: string) => void) | undefined,
  ) => {
    const purpose = String(request.headers['x-picasso-purpose'] ?? '').trim();
    if (!purpose) return send(400, { error: 'an export states its purpose in X-Picasso-Purpose; it goes on the audit trail' });
    const bad = checkPurpose(purpose);
    if (bad) return send(400, { error: bad });
    if (!o.audit) return send(503, { error: 'no audit trail is configured, so nothing is exported' });
    let body: { title?: unknown; leavesTenant?: unknown; cells?: unknown };
    try {
      body = JSON.parse(await readBody(request, 4 << 20)) as typeof body;
    } catch (err) {
      return send(400, { error: `body: ${(err as Error).message}` });
    }
    if (typeof body.title !== 'string' || !body.title.trim() || typeof body.leavesTenant !== 'boolean' || !Array.isArray(body.cells) || body.cells.length === 0) {
      return send(400, { error: 'an export names its title, whether it leaves the tenant, and at least one cell' });
    }
    const trace = traceId(request.headers.traceparent as string | undefined);
    const record = { actor: ctx.user, tenant: ctx.tenant, action: 'export', resource: doc, purpose, traceId: trace };
    let bundle;
    try {
      bundle = buildBundle({
        title: body.title, tenantId: ctx.tenant, actor: ctx.user, purpose, cells: body.cells as ExportCell[],
        vendorPolicies: o.vendorPolicies ?? [], leavesTenant: body.leavesTenant, at: Date.now(),
      });
    } catch (err) {
      const refusal = err instanceof ExportWouldLeak ? 403 : err instanceof UnreproducibleExport ? 422 : 0;
      if (!refusal) throw err;
      try {
        await o.audit.append({ ...record, outcome: `refused: ${(err as Error).name}` });
      } catch (aerr) {
        return send(503, { error: `the audit trail could not be written: ${(aerr as Error).message}` });
      }
      return send(refusal, { error: (err as Error).message, traceId: trace });
    }
    const redacted = bundle.cells.filter((c) => c.redaction).length;
    try {
      await o.audit.append({
        ...record,
        outcome: `exported ${bundle.cells.length} cells, ${redacted} redacted, ${body.leavesTenant ? 'leaving the tenant' : 'within the tenant'}${pdf ? ', as PDF' : ''}`,
      });
    } catch (aerr) {
      return send(503, { error: `the audit trail could not be written, so nothing is exported: ${(aerr as Error).message}` });
    }
    if (pdf) pdf(bundlePdf(bundle, { traceId: trace }), trace);
    else send(200, { bundle, traceId: trace });
  };

  const persistence: Extension<Context> = {
    extensionName: 'picasso-postgres',
    async onAuthenticate({ token, documentName, requestHeaders }) {
      const sessionToken = token && token.split('.').length === 3 ? token : cookieToken(requestHeaders.get('cookie'));
      return authenticate(await identify(sessionToken, token), documentName);
    },
    async connected({ connection, context }) {
      const sid = context?.sid;
      if (!sid) return;
      const set = open.get(sid) ?? new Set();
      set.add(connection);
      open.set(sid, set);
      connection.onClose(() => {
        set.delete(connection);
        if (set.size === 0 && open.get(sid) === set) open.delete(sid);
      });
    },
    async beforeHandleMessage({ context }) {
      const reason = await ended(context?.sid);
      // Hocuspocus closes the connection on a throw, and the message is not applied.
      if (reason) throw Object.assign(new Error(reason), { code: 4401, reason });
    },
    async onLoadDocument({ document, documentName }) {
      const loaded = await store.load(documentName);
      // Rows commit in position order per canvas, so what the load read is
      // every row through its last one.
      watermark.set(documentName, loaded.throughUpdate);
      beyond.set(documentName, new Set());
      if (loaded.state) Y.applyUpdate(document, loaded.state, LOADED);
      return document;
    },
    async onChange({ documentName, update, context, transactionOrigin }) {
      if (transactionOrigin === LOADED || transactionOrigin === FANNED_IN) return;
      lastChange.set(documentName, Date.now());
      // Appends for one canvas are chained, so the log keeps arrival order.
      const write = (pending.get(documentName) ?? Promise.resolve()).then(async () => {
        const seq = await store.append(documentName, context?.user ?? 'server', update, instanceId);
        held(documentName, seq);
      });
      pending.set(documentName, write.catch((err) => console.error(`update log for ${documentName}: ${(err as Error).message}`)));
      await write;
    },
    async onStoreDocument({ documentName, document }) {
      // A snapshot claims only the rows this copy holds with no gap before
      // them, checked against the log. It may hold more, rows still being
      // heard about or written; a load replays from the claim, and Yjs
      // updates are idempotent, so nothing is lost and nothing doubled.
      await pending.get(documentName);
      const quiet = Date.now() - (lastChange.get(documentName) ?? 0) >= idleMs * 0.9;
      counts[quiet ? 'idle' : 'interval'] += 1;
      const state = Y.encodeStateAsUpdate(document);
      await store.snapshot(documentName, state, await advance(documentName), quiet ? 'idle' : 'interval');
    },
    async onAwarenessUpdate({ documentName, transactionOrigin, added, updated, removed, awareness }) {
      // Presence fans out like edits, and is not logged.
      if (transactionOrigin === FANNED_IN) return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      await store.announcePresence(documentName, encodeAwarenessUpdate(awareness, changed), instanceId).catch((err) => console.error(`presence for ${documentName}: ${(err as Error).message}`));
    },
    async onRequest({ request, response, instance }: onRequestPayload) {
      const url = new URL(request.url ?? '/', 'http://collab');
      if (!url.pathname.startsWith('/v1/')) return;
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(body));
      };
      try {
        if (url.pathname === '/v1/healthz') {
          send(200, { ok: true });
          throw null;
        }
        // The session secret the client's offline store is keyed from, and
        // logout, which ends it. Not per canvas: one session, every canvas.
        if (url.pathname === '/v1/session' || url.pathname === '/v1/logout') {
          let user = '';
          try {
            const who = await identify(httpToken(request.headers), String(request.headers['x-picasso-user'] ?? ''));
            if (!o.users[who.user] || (who.tenant !== undefined && who.tenant !== o.users[who.user]!.tenant)) throw new Error('unknown user');
            user = who.user;
          } catch (err) {
            send(403, { error: (err as Error).message });
            throw null;
          }
          if (request.method !== 'POST') {
            send(405, { error: 'POST only' });
            throw null;
          }
          if (url.pathname === '/v1/session') send(200, { secret: Buffer.from(await store.sessionSecret(user)).toString('base64') });
          else send(200, { ended: await store.endSession(user) });
          throw null;
        }
        const doc = url.searchParams.get('doc') ?? '';
        let ctx: Context;
        try {
          ctx = authenticate(await identify(httpToken(request.headers), String(request.headers['x-picasso-user'] ?? '')), doc);
        } catch (err) {
          send(403, { error: (err as Error).message });
          throw null;
        }
        if (url.pathname === '/v1/versions' && request.method === 'GET') {
          send(200, { versions: await store.versions(doc) });
        } else if (url.pathname === '/v1/versions' && request.method === 'POST') {
          const name = (url.searchParams.get('name') ?? '').trim();
          if (!name) {
            send(400, { error: 'a version needs a name' });
            throw null;
          }
          // The live state if the canvas is open here, else what is stored.
          const live = instance.documents.get(doc);
          const state = live ? Y.encodeStateAsUpdate(live) : (await store.load(doc)).state;
          if (!state) {
            send(404, { error: `no canvas ${doc}` });
            throw null;
          }
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, state);
          const asof = String(metaOf(ydoc).get('asof') ?? '');
          try {
            send(201, await store.createVersion(doc, name, ctx.user, state, datasetSnapshotsOf(ydoc), asof));
          } catch (err) {
            if (err instanceof VersionExists) send(409, { error: err.message });
            else throw err;
          }
        } else if (url.pathname === '/v1/exports' && request.method === 'POST') {
          const asPdf = url.searchParams.get('format') === 'pdf';
          await exportBundle(request, ctx, doc, send, asPdf
            ? (bytes, trace) => {
                response.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="export.pdf"', 'cache-control': 'no-store', 'x-picasso-trace': trace });
                response.end(Buffer.from(bytes));
              }
            : undefined);
        } else if (url.pathname === '/v1/versions/state' && request.method === 'GET') {
          const v = await store.version(doc, url.searchParams.get('name') ?? '');
          if (!v) send(404, { error: 'no such version' });
          else send(200, { ...v, state: Buffer.from(v.state).toString('base64') });
        } else {
          send(404, { error: 'not found' });
        }
      } catch (err) {
        if (err === null) throw null;
        if (!response.headersSent) send(500, { error: (err as Error).message });
      }
      throw null;
    },
  };

  const server = new Server<Context>({
    port: o.port ?? 0,
    address: o.address ?? '127.0.0.1',
    quiet: true,
    stopOnSignals: false,
    debounce: idleMs,
    maxDebounce: snapshotEveryMs,
    unloadImmediately: false,
    extensions: [persistence],
  });
  await server.listen();

  /**
   * More than one process (PRD 7.3). Every update is announced on Postgres as
   * it is logged, and each instance applies what the others log to the
   * canvases it has open, so clients on different instances edit one canvas.
   * Yjs updates are idempotent and commute, so the order notifications
   * arrive in does not matter. A canvas not open here is not touched: it
   * loads from the log when someone opens it.
   */
  const apply = (doc: string, seq: number, body: Uint8Array) => {
    const open = server.hocuspocus.documents.get(doc);
    if (!open) return;
    Y.applyUpdate(open, body, FANNED_IN);
    held(doc, seq);
    fannedIn.count += 1;
  };
  const stopListening = await store.listen({
    update: ({ doc, seq, from }) => {
      if (from === instanceId || !server.hocuspocus.documents.has(doc)) return;
      void store.update(doc, seq).then(
        (body) => body && apply(doc, seq, body),
        (err) => console.error(`fan-out of ${doc}#${seq}: ${(err as Error).message}`),
      );
    },
    presence: ({ doc, from, update }) => {
      const open = server.hocuspocus.documents.get(doc);
      if (from === instanceId || !open) return;
      applyAwarenessUpdate(open.awareness, update, FANNED_IN);
    },
    // Anything announced while the listener was away is caught up from the
    // log: every row after the watermark that this copy does not hold.
    onReconnect: () => {
      reconnects.count += 1;
      for (const doc of server.hocuspocus.documents.keys()) {
        void store.updatesAfter(doc, watermark.get(doc) ?? 0).then(
          (rows) => {
            for (const { seq, body } of rows) if (!beyond.get(doc)?.has(seq)) apply(doc, seq, body);
          },
          (err) => console.error(`catching up ${doc}: ${(err as Error).message}`),
        );
      }
    },
  });
  const retentionEveryMs = o.retentionEveryMs ?? 6 * 3_600_000;
  const retain = () =>
    store.retain().then(
      (r) => (r.updates || r.snapshots ? console.error(`retention: ${r.updates} updates and ${r.snapshots} snapshots past ninety days removed, ${r.snapshotted} canvases snapshotted first`) : undefined),
      (err) => console.error(`retention: ${(err as Error).message}`),
    );
  const timers: NodeJS.Timeout[] = [];
  if (retentionEveryMs > 0) {
    timers.push(setTimeout(() => {
      void retain();
      timers.push(setInterval(() => void retain(), retentionEveryMs).unref());
    }, Math.min(60_000, retentionEveryMs)).unref());
  }
  return {
    server,
    store,
    url: server.webSocketURL,
    snapshots: counts,
    fannedIn,
    reconnects,
    destroy: async () => {
      for (const t of timers) clearTimeout(t);
      if (sweeper) clearInterval(sweeper);
      await stopListening();
      return server.destroy();
    },
  };
}
