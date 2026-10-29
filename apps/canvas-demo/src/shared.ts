/**
 * One canvas, shared through the collaboration server (services/collab).
 *
 * collab.html joins two panes in-page; this is one user in one tab, synced
 * through picasso-collab over the demo server's `/collab/` proxy, and kept in
 * Postgres. Open it in two tabs as two users and they edit one canvas; reload
 * either and it comes back from the server; go offline and keep working, and
 * the edits merge on reconnect. A named version is taken by the server from the
 * canvas as it stands, with the dataset snapshots its nodes cite.
 *
 *   shared.html?user=pm&doc=dev/semis
 */

import { CanvasIndex, createNode, type NodeKind, type Viewport } from '@picasso/canvas-core';
import { buildScene, lightTheme } from '@picasso/canvas-render';
import { EncryptedStore, IndexedDbBacking, OfflineCanvas, RecordUnreadable, SyncedCanvas } from '@picasso/canvas-sync';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { drawScene } from './draw.js';

const params = new URLSearchParams(window.location.search);
const user = params.get('user') ?? 'pm';
const docName = params.get('doc') ?? 'dev/semis';
const KINDS: NodeKind[] = ['ChartNode', 'DataTile', 'TableNode', 'CurveNode', 'ScenarioNode'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const element = $<HTMLCanvasElement>('canvas');
const ctx = element.getContext('2d') as CanvasRenderingContext2D;
const status = $('status');
const errorBox = $('error');
const versionsBox = $('versions');
$('who').textContent = `${user} · ${docName}`;

const canvas = new SyncedCanvas();
const index = new CanvasIndex(canvas.snapshot());
let viewport: Viewport = { x: -20, y: -20, scale: 0.6, width: 0, height: 0 };
let refused: string | undefined;
let online = true;

// The device's copy first: everything this session left here, edits made
// offline included, replayed before the server is asked for anything. The key
// comes from the session secret the server holds, so a tab opened offline has
// the records and cannot read them until the session is reachable.
let offline: OfflineCanvas | undefined;
let offlineStore: EncryptedStore | undefined;
let offlineNote = 'no offline copy';
let signedOut = false;
try {
  const res = await fetch('/collab/v1/session', { method: 'POST', headers: { 'X-Picasso-User': user } });
  if (!res.ok) throw new Error(`no session (${res.status})`);
  const { secret } = (await res.json()) as { secret: string };
  const backing = await IndexedDbBacking.open(`picasso-offline-${user}`);
  offlineStore = await EncryptedStore.open(backing, Uint8Array.from(atob(secret), (c) => c.charCodeAt(0)), 'canvas');
  try {
    offline = await OfflineCanvas.attach(canvas.doc, offlineStore, backing, docName);
  } catch (err) {
    if (!(err instanceof RecordUnreadable)) throw err;
    // Written under a session that has ended: unreadable for good, so cleared.
    for (const key of (await backing.keys()).filter((k) => k.startsWith(`${docName}#`))) await backing.delete(key);
    offline = await OfflineCanvas.attach(canvas.doc, offlineStore, backing, docName);
  }
  offlineNote = `offline copy · ${offline.replayed} records replayed`;
} catch (err) {
  offlineNote = `offline copy unavailable: ${(err as Error).message}`;
}

const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/collab`;
const provider = new HocuspocusProvider({
  url: wsUrl,
  name: docName,
  document: canvas.doc,
  token: user,
  onAuthenticationFailed: ({ reason }) => {
    refused = reason;
  },
  // Versions are listed once the server has let this user in, not before:
  // a refused user has no business asking for them.
  onSynced: () => {
    void listVersions();
  },
});

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = element.parentElement!.getBoundingClientRect();
  element.width = Math.round(rect.width * dpr);
  element.height = Math.round(rect.height * dpr);
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  viewport = { ...viewport, width: rect.width, height: rect.height };
}
window.addEventListener('resize', resize);

let added = 0;
// Each user works in their own band, as in collab.html, so two users adding
// nodes at once, or offline, do not stack them on the same spot.
const band = ['pm', 'analyst'].indexOf(user) + 1;
function addNode(): void {
  // The slot comes from the user's nodes in the document, not a counter
  // that a reload would reset.
  const n = [...canvas.snapshot().nodes.keys()].filter((k) => k.startsWith(`${user}-`)).length;
  added += 1;
  const id = `${user}-${Date.now().toString(36)}-${added}`;
  canvas.addNode(createNode({
    id,
    kind: KINDS[n % KINDS.length] as NodeKind,
    binding: 'wired',
    position: { x: 30 + (n % 5) * 240, y: 30 + band * 200 - 200 + Math.floor(n / 5) * 400 },
    size: { w: 210, h: 140 },
    params: { ticker: ['NVDA', 'AMD', 'AVGO', 'UST10Y'][n % 4] as string },
  }));
  // Cite a dataset snapshot, as a node computed against one would.
  canvas.setProvenance(id, { datasetSnapshots: { iceberg: 'ice-0801' }, asof: '2024-08-05T09:30:00Z', verified: true });
}

async function collab(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`/collab${path}`, { ...init, headers: { 'X-Picasso-User': user } });
}

async function listVersions(): Promise<void> {
  const res = await collab(`/v1/versions?doc=${encodeURIComponent(docName)}`);
  if (!res.ok) return;
  const { versions } = (await res.json()) as { versions: Array<{ name: string; author: string; datasetSnapshots: Record<string, string[]> }> };
  versionsBox.textContent = versions.length === 0
    ? 'no named versions'
    : `versions: ${versions.map((v) => `${v.name} (${v.author}; ${Object.entries(v.datasetSnapshots).map(([s, ids]) => `${s} ${ids.join('/')}`).join(', ') || 'no datasets'})`).join(' · ')}`;
}

$('add').addEventListener('click', addNode);
$('link').addEventListener('click', () => {
  online = !online;
  if (online) void provider.connect();
  else provider.disconnect();
  $('link').textContent = online ? 'go offline' : 'reconnect';
});
$('save').addEventListener('click', async () => {
  errorBox.textContent = '';
  const name = $<HTMLInputElement>('version-name').value.trim();
  const res = await collab(`/v1/versions?doc=${encodeURIComponent(docName)}&name=${encodeURIComponent(name)}`, { method: 'POST' });
  if (!res.ok) errorBox.textContent = ((await res.json()) as { error: string }).error;
  await listVersions();
});

$('logout').addEventListener('click', async () => {
  // The session ends at the server, the key is dropped here, and the sealed
  // copy is erased: nothing of this session stays readable or on the disk.
  await fetch('/collab/v1/logout', { method: 'POST', headers: { 'X-Picasso-User': user } });
  offline?.detach();
  await offlineStore?.lock({ erase: true });
  provider.destroy();
  signedOut = true;
});

function state(): 'signed-out' | 'refused' | 'offline' | 'synced' | 'connecting' {
  if (signedOut) return 'signed-out';
  if (refused !== undefined) return 'refused';
  if (!online) return 'offline';
  return provider.isSynced ? 'synced' : 'connecting';
}

function frame(now: number): void {
  index.rebuild(canvas.snapshot());
  drawScene(ctx, buildScene({ doc: canvas.snapshot(), index, viewport, theme: lightTheme, now }), { theme: lightTheme, now, dpr: 1 });
  const s = state();
  status.dataset.state = s;
  status.textContent = s === 'refused' ? `refused: ${refused}` : `${s} · ${canvas.nodeCount} nodes · ${offlineNote}`;
  requestAnimationFrame(frame);
}

resize();
requestAnimationFrame(frame);

declare global {
  interface Window {
    __shared: { state(): string; nodes(): string[]; add(): void; versions(): Promise<void>; offline(): { note: string; records: number; flushed(): Promise<void> } };
  }
}
window.__shared = {
  state,
  nodes: () => [...canvas.snapshot().nodes.keys()].sort(),
  add: addNode,
  versions: listVersions,
  offline: () => ({ note: offlineNote, records: offline?.recordCount ?? 0, flushed: () => offline?.flushed() ?? Promise.resolve() }),
};
