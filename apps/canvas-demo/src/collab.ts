/**
 * Two clients, one canvas.
 *
 * Each pane is a separate Yjs document with its own index, viewport and
 * renderer — as separate as two browsers — joined by a `Room` that plays the
 * part of the collab server. Cutting the link lets both sides keep editing;
 * restoring it merges them, with no queue and no replay log.
 *
 * The peer cursor is presence, not document: it rides its own channel at 20Hz
 * and never enters the CRDT.
 */

import {
  CanvasIndex,
  createNode,
  type NodeKind,
  type PicassoNode,
  type Viewport,
} from '@picasso/canvas-core';
import { buildScene, lightTheme } from '@picasso/canvas-render';
import {
  PresenceThrottle,
  Room,
  SyncedCanvas,
  colorForClient,
  type PresenceState,
} from '@picasso/canvas-sync';
import { drawScene } from './draw.js';

const theme = lightTheme;
const room = new Room();

const KINDS: NodeKind[] = [
  'ChartNode', 'DataTile', 'TableNode', 'MonteCarloNode', 'ScenarioNode',
  'StrategyNode', 'CurveNode', 'TransformNode',
];
const TICKERS = ['NVDA', 'AMD', 'AVGO', 'SOXL', 'UST10Y', 'VIX', 'SOFR', 'BTC'];

interface Peer {
  name: string;
  clientId: number;
  canvas: SyncedCanvas;
  index: CanvasIndex;
  element: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  status: HTMLElement;
  viewport: Viewport;
  presence: PresenceThrottle;
  /** The other peer's last published presence, as received. */
  peerPresence?: PresenceState;
  online: boolean;
  seq: number;
}

function makePeer(name: string, clientId: number, canvasId: string, statusId: string): Peer {
  const element = document.getElementById(canvasId) as HTMLCanvasElement;
  const ctx = element.getContext('2d');
  if (!ctx) throw new Error('Canvas2D unavailable');
  const canvas = new SyncedCanvas({ id: 'semis-and-duration' });
  room.join(canvas.doc);

  return {
    name,
    clientId,
    canvas,
    index: new CanvasIndex(canvas.snapshot()),
    element,
    ctx,
    status: document.getElementById(statusId) as HTMLElement,
    viewport: { x: -30, y: -30, scale: 0.55, width: 0, height: 0 },
    presence: new PresenceThrottle({ clientId, name, color: colorForClient(clientId) }),
    online: true,
    seq: 0,
  };
}

const a = makePeer('Maya', 1, 'canvas-a', 'status-a');
const b = makePeer('Ravi', 2, 'canvas-b', 'status-b');
const peers = [a, b];

function other(peer: Peer): Peer {
  return peer === a ? b : a;
}

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const peer of peers) {
    const rect = peer.element.parentElement?.getBoundingClientRect();
    const width = Math.max(200, Math.round(rect?.width ?? 480));
    const height = Math.max(200, Math.round((rect?.height ?? 520) - 34));
    peer.element.width = Math.round(width * dpr);
    peer.element.height = Math.round(height * dpr);
    peer.element.style.width = `${width}px`;
    peer.element.style.height = `${height}px`;
    peer.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    peer.viewport = { ...peer.viewport, width, height };
  }
}
window.addEventListener('resize', resize);

/** Places a new node somewhere free-ish, so the demo does not stack them. */
function addNode(peer: Peer): PicassoNode {
  const index = peer.seq++;
  const kind = KINDS[(peer.clientId * 3 + index) % KINDS.length] as NodeKind;
  const column = index % 3;
  const row = Math.floor(index / 3);
  const node = createNode({
    id: `${peer.name.toLowerCase()}-${index}`,
    kind,
    binding: index % 4 === 3 ? 'loose' : 'wired',
    position: {
      // Each analyst works in their own band, so after a merge you can see
      // whose work arrived rather than one set of nodes hiding the other.
      x: 40 + column * 250,
      y: 40 + row * 190 + (peer.clientId === 1 ? 0 : 400),
    },
    size: { w: 210, h: 140 },
    params: { ticker: TICKERS[(peer.clientId + index) % TICKERS.length] as string },
    inputs: [{ id: 'in', name: 'in', type: 'series', cardinality: 'many', required: false }],
    outputs: [{ id: 'out', name: 'out', type: 'series', cardinality: 'many', required: false }],
  });
  peer.canvas.addNode(node);
  return node;
}

function setOnline(peer: Peer, online: boolean): void {
  peer.online = online;
  room.setOnline(peer.canvas.doc, online);
}

for (const peer of peers) {
  peer.element.addEventListener('pointermove', (event) => {
    const rect = peer.element.getBoundingClientRect();
    const cursor = {
      x: (event.clientX - rect.left) / peer.viewport.scale + peer.viewport.x,
      y: (event.clientY - rect.top) / peer.viewport.scale + peer.viewport.y,
    };
    const published = peer.presence.offer({ cursor }, event.timeStamp);
    // Presence rides its own channel: it is delivered even when the document
    // link is down, because a cursor is not part of the document.
    if (published) other(peer).peerPresence = published;
  });
}

document.getElementById('add-a')?.addEventListener('click', () => addNode(a));
document.getElementById('add-b')?.addEventListener('click', () => addNode(b));
document.getElementById('link')?.addEventListener('click', () => {
  const next = !b.online;
  setOnline(b, next);
});

function drawPeerCursor(peer: Peer): void {
  const presence = peer.peerPresence;
  if (!presence?.cursor) return;
  const { ctx, viewport } = peer;
  const x = (presence.cursor.x - viewport.x) * viewport.scale;
  const y = (presence.cursor.y - viewport.y) * viewport.scale;

  ctx.save();
  ctx.fillStyle = presence.color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 11, y + 4);
  ctx.lineTo(x + 4.5, y + 6);
  ctx.lineTo(x + 3, y + 12);
  ctx.closePath();
  ctx.fill();

  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  const label = presence.name;
  const width = ctx.measureText(label).width + 10;
  ctx.fillRect(x + 10, y + 8, width, 16);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 15, y + 17);
  ctx.restore();
}

function frame(now: number): void {
  for (const peer of peers) {
    peer.index.rebuild(peer.canvas.snapshot());
    const scene = buildScene({
      doc: peer.canvas.snapshot(),
      index: peer.index,
      viewport: peer.viewport,
      theme,
      now,
    });
    drawScene(peer.ctx, scene, { theme, now, dpr: 1 });
    drawPeerCursor(peer);

    const flushed = peer.presence.flush(now);
    if (flushed) other(peer).peerPresence = flushed;

    peer.status.textContent =
      `${peer.name} · ${peer.canvas.nodeCount} nodes · ${peer.online ? 'online' : 'OFFLINE'}`;
    peer.status.dataset.online = String(peer.online);
  }

  const linkButton = document.getElementById('link');
  if (linkButton) linkButton.textContent = b.online ? 'cut the link' : 'reconnect';

  const converged = a.canvas.nodeCount === b.canvas.nodeCount;
  const verdict = document.getElementById('verdict');
  if (verdict) {
    verdict.textContent = converged
      ? `converged · ${a.canvas.nodeCount} nodes on both`
      : `diverged while offline · ${a.canvas.nodeCount} vs ${b.canvas.nodeCount}`;
    verdict.dataset.converged = String(converged);
  }

  requestAnimationFrame(frame);
}

resize();
// Seed a little shared history so both panes start with the same canvas.
for (let i = 0; i < 3; i++) addNode(a);
for (let i = 0; i < 2; i++) addNode(b);
requestAnimationFrame(frame);

declare global {
  interface Window {
    __collab?: {
      counts: () => { a: number; b: number };
      converged: () => boolean;
      addTo: (which: 'a' | 'b') => void;
      setOnline: (which: 'a' | 'b', online: boolean) => void;
      cursors: () => { a?: PresenceState; b?: PresenceState };
    };
  }
}
window.__collab = {
  counts: () => ({ a: a.canvas.nodeCount, b: b.canvas.nodeCount }),
  converged: () =>
    JSON.stringify([...a.canvas.snapshot().nodes.keys()].sort()) ===
    JSON.stringify([...b.canvas.snapshot().nodes.keys()].sort()),
  addTo: (which) => addNode(which === 'a' ? a : b),
  setOnline: (which, online) => setOnline(which === 'a' ? a : b, online),
  cursors: () => {
    const result: { a?: PresenceState; b?: PresenceState } = {};
    if (a.peerPresence) result.a = a.peerPresence;
    if (b.peerPresence) result.b = b.peerPresence;
    return result;
  },
};
