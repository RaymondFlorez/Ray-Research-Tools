/**
 * Live tiles over the Go data plane (PRD 3.6, 7.2, 7.4).
 *
 * The page reads `/v1/stream` through the demo server's proxy and folds it
 * into tiles with canvas-data's `LiveTiles`. Every number on it goes through
 * canvas-guard's `present()`, so it cannot be drawn without its source and
 * its age, and a stale or recovering series carries the badge saying so. A
 * tile the user is not licensed for shows the reason and no number.
 *
 * The feed is whatever the data plane says it is: a replayed recording, until
 * a vendor is connected. That name is each tile's source.
 */

import { LiveTiles, parseSse, type TileView } from '@picasso/canvas-data';
import { LADDER, present, type Rung } from '@picasso/canvas-guard';

const INSTRUMENTS = ['NVDA', 'AMD'];
const grid = document.getElementById('tiles') as HTMLElement;
const status = document.getElementById('status') as HTMLElement;
const userPicker = document.getElementById('user') as HTMLSelectElement;

const STALE = LADDER.find((r) => r.level === 3) as Rung;
const RECOVERING: Rung = { ...STALE, badge: 'recovering after a feed gap' };

let tiles = new LiveTiles();
let feed = 'connecting';
let connection: AbortController | null = null;
let connected = false;

async function connect(): Promise<void> {
  connection?.abort();
  const abort = new AbortController();
  connection = abort;
  tiles = new LiveTiles();
  connected = false;
  const user = userPicker.value;
  const headers = { 'X-Picasso-User': user };
  try {
    const info = await fetch('/v1/feed', { headers, signal: abort.signal });
    feed = info.ok ? ((await info.json()) as { feed: string }).feed : `data plane: ${info.status}`;
    const res = await fetch(`/v1/stream?${INSTRUMENTS.map((i) => `subject=tick.equity.${i}`).join('&')}`, { headers, signal: abort.signal });
    if (!res.ok || !res.body) throw new Error(`stream: ${res.status}`);
    connected = true;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const parsed = parseSse(rest + value);
      rest = parsed.rest;
      for (const e of parsed.events) tiles.apply(e, Date.now());
    }
  } catch (err) {
    if (!abort.signal.aborted) feed = `disconnected: ${(err as Error).message}`;
  } finally {
    if (connection === abort) connected = false;
  }
}

function render(view: TileView, now: number): string {
  const head = `<div class="sym">${view.instrument}</div>`;
  if (view.kind === 'blocked') {
    return `<div class="tile blocked" data-kind="blocked">${head}<div class="value">—</div><div class="caption">blocked · ${view.reason}</div></div>`;
  }
  if (view.kind === 'waiting' || view.asOfMs === undefined || view.values?.price === undefined) {
    return `<div class="tile waiting" data-kind="waiting">${head}<div class="value">…</div><div class="caption">waiting for the first update</div></div>`;
  }
  const rung = view.state === 'stale' ? STALE : view.state === 'recovering' ? RECOVERING : undefined;
  const shown = present(view.values.price.toFixed(2), { source: feed, asof: new Date(view.asOfMs).toISOString(), asofMs: view.asOfMs }, now, rung);
  return `<div class="tile ${view.state}" data-kind="value" data-state="${view.state}">${head}<div class="value">${shown.value}</div>` +
    `<div class="caption">${shown.caption}</div><div class="detail">${view.ticks ?? 0} ticks in the last update${view.reason ? ` · ${view.reason}` : ''}</div></div>`;
}

function frame(): void {
  const now = Date.now();
  grid.innerHTML = INSTRUMENTS.map((i) => render(tiles.tile(i, now), now)).join('');
  status.textContent = `${connected ? 'connected' : 'not connected'} as ${userPicker.value} · ${feed} · ${tiles.updatesApplied} updates`;
  requestAnimationFrame(frame);
}

userPicker.addEventListener('change', () => void connect());
void connect();
requestAnimationFrame(frame);

declare global {
  interface Window {
    __live?: { tiles: () => TileView[]; updates: () => number; feed: () => string; connected: () => boolean };
  }
}
window.__live = {
  tiles: () => INSTRUMENTS.map((i) => tiles.tile(i, Date.now())),
  updates: () => tiles.updatesApplied,
  feed: () => feed,
  connected: () => connected,
};
