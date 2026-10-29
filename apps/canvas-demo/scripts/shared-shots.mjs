/**
 * Two browsers, one canvas, through the real collaboration server.
 *
 * Starts services/collab against Postgres (COLLAB_PG_URL), serves the demo
 * with `/collab/` proxied to it, and opens shared.html in two separate browser
 * contexts as two users. Checks that edits reach the other browser; that a
 * reload brings the canvas back from the server, and so does a restart of the
 * server itself; that offline edits on both sides merge; that a named version
 * records what the canvas cites and cannot be taken twice; and that a user
 * cannot open another tenant's canvas.
 *
 *   COLLAB_PG_URL=postgres://... node apps/canvas-demo/scripts/shared-shots.mjs [outDir]
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

async function resolveChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return undefined;
  const entries = await readdir(base);
  for (const dir of entries.filter((d) => d.startsWith('chromium')).sort().reverse()) {
    for (const candidate of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const full = `${base}/${dir}/${candidate}`;
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

const PG = process.env.COLLAB_PG_URL;
if (!PG) {
  console.error('COLLAB_PG_URL is required: the canvas is kept in Postgres, and this checks that it is');
  process.exit(1);
}
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = process.argv[2] ?? fileURLToPath(new URL('../shots', import.meta.url));
const PORT = Number(process.env.PORT ?? 8350);
const COLLAB_PORT = Number(process.env.COLLAB_PORT ?? 8762);
const SCHEMA = `shared_${Date.now().toString(36)}`;

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
}

async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never came up: ${url}`);
}

const collabArgs = (migrate) => [join(ROOT, 'services/collab/dist/main.js'), '--dev-identity', '--pg', PG, '--users', join(ROOT, 'services/dataplane/config/users.json'),
  '--schema', SCHEMA, '--port', String(COLLAB_PORT), ...(migrate ? ['--migrate'] : [])];
const startCollab = async (migrate) => {
  const child = spawn(process.execPath, collabArgs(migrate), { stdio: ['ignore', 'ignore', 'inherit'] });
  await waitFor(`http://127.0.0.1:${COLLAB_PORT}/v1/healthz`);
  return child;
};

/** Reads one IndexedDB store of the page's origin: keys and raw values, as latin-1 text. */
const readDevice = (p, database) => p.evaluate((name) => new Promise((resolve, reject) => {
  const req = indexedDB.open(name);
  window.__probe = req;
  req.onerror = () => reject(new Error(String(req.error)));
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('records')) {
      db.close();
      resolve({ keys: 0, text: '' });
      return;
    }
    const tx = db.transaction('records');
    const store = tx.objectStore('records');
    const values = store.getAll();
    const keys = store.getAllKeys();
    window.__probeTx = tx;
    tx.oncomplete = () => {
      db.close();
      // Each record read raw, and read the way an unsealed one would be — JSON
      // holding base64 — since ids would not show in the raw bytes either way.
      const asIfUnsealed = (bytes) => {
        try {
          return atob(JSON.parse(new TextDecoder().decode(bytes)));
        } catch {
          return '';
        }
      };
      const raw = values.result.map((v) => new Uint8Array(v));
      resolve({ keys: keys.result.length, text: raw.map((b) => String.fromCharCode(...b) + asIfUnsealed(b)).join('') });
    };
    tx.onerror = () => reject(new Error(String(tx.error)));
  };
}), database);

let collab = await startCollab(true);
const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), COLLAB_URL: `http://127.0.0.1:${COLLAB_PORT}` }, stdio: 'ignore' });
const page = (user, doc = 'dev/semis') => `http://localhost:${PORT}/apps/canvas-demo/shared.html?user=${user}&doc=${encodeURIComponent(doc)}`;

try {
  await waitFor(`http://localhost:${PORT}/apps/canvas-demo/shared.html`);
  await mkdir(OUT, { recursive: true });
  const executablePath = await resolveChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const errors = [];
  const tab = async (user, doc) => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 560 } });
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(`${user}: ${e}`));
    p.on('console', (m) => m.type() === 'error' && !/status of 409/.test(m.text()) && errors.push(`${user}: ${m.text()}`));
    await p.goto(page(user, doc));
    return p;
  };
  const synced = (p) => p.waitForFunction(() => window.__shared?.state() === 'synced', null, { timeout: 10_000 });
  const nodes = (p) => p.evaluate(() => window.__shared.nodes());
  const settle = (p, fn, arg) => p.waitForFunction(fn, arg, { timeout: 5_000 }).catch(() => {});

  // 1. Two users, two browsers, one canvas.
  const pm = await tab('pm');
  const analyst = await tab('analyst');
  await synced(pm);
  await synced(analyst);
  check('both browsers sync with the server', true);
  await pm.click('#add');
  await pm.click('#add');
  await analyst.click('#add');
  await settle(pm, () => window.__shared.nodes().length === 3);
  await settle(analyst, () => window.__shared.nodes().length === 3);
  const shared = await nodes(pm);
  check('edits in either browser reach the other', shared.length === 3 && JSON.stringify(shared) === JSON.stringify(await nodes(analyst)), shared.join(' '));
  await pm.screenshot({ path: `${OUT}/shared-two-users.png` });

  // 2. A reload comes back from the server.
  await pm.reload();
  await synced(pm);
  await settle(pm, () => window.__shared.nodes().length === 3);
  check('a reloaded browser gets the canvas back from the server', JSON.stringify(await nodes(pm)) === JSON.stringify(shared));

  // 3. Offline on one side, edits on both, then reconnect.
  await analyst.click('#link');
  await settle(analyst, () => window.__shared.state() === 'offline');
  await pm.click('#add');
  await analyst.click('#add');
  await analyst.click('#add');
  await pm.waitForTimeout(400);
  const apart = [(await nodes(pm)).length, (await nodes(analyst)).length];
  check('offline, each side sees only its own new work', apart[0] === 4 && apart[1] === 5, apart.join(' vs '));
  await analyst.click('#link');
  await settle(pm, () => window.__shared.nodes().length === 6);
  await settle(analyst, () => window.__shared.state() === 'synced' && window.__shared.nodes().length === 6);
  const merged = await nodes(pm);
  check('reconnecting merges both sides with nothing lost', merged.length === 6 && JSON.stringify(merged) === JSON.stringify(await nodes(analyst)), `${merged.length} nodes`);

  // 3b. A tab closed while offline keeps its edits on the device, sealed, and
  // the next tab of the session sends them.
  await analyst.click('#link');
  await settle(analyst, () => window.__shared.state() === 'offline');
  await analyst.click('#add');
  await analyst.click('#add');
  await analyst.evaluate(() => window.__shared.offline().flushed());
  const madeOffline = (await nodes(analyst)).filter((n) => !merged.includes(n));
  const context = analyst.context();
  await analyst.close();
  await pm.waitForTimeout(300);
  check('a tab closed offline: its two edits never reached the server', madeOffline.length === 2 && !(await nodes(pm)).some((n) => madeOffline.includes(n)));
  const probe = await context.newPage();
  await probe.goto(`http://localhost:${PORT}/apps/canvas-demo/index.html`);
  const raw = (await readDevice(probe, 'picasso-offline-analyst')).text;
  await probe.close();
  check('what the device holds is ciphertext: no node id, kind or ticker in it', raw.length > 0 && !/analyst-|pm-|ChartNode|NVDA/.test(raw), `${raw.length} bytes`);
  const back = await context.newPage();
  back.on('pageerror', (e) => errors.push(`analyst: ${e}`));
  await back.goto(page('analyst'));
  await synced(back);
  await settle(pm, (ids) => ids.every((id) => window.__shared.nodes().includes(id)), madeOffline);
  const note = await back.evaluate(() => window.__shared.offline().note);
  check('the next tab replays the sealed copy and the server receives the edits', (await nodes(pm)).filter((n) => madeOffline.includes(n)).length === 2 && /records replayed/.test(note) && !/ 0 records/.test(note), note);
  const before8 = await nodes(pm);

  // 4. The server restarts; the canvas is in Postgres.
  collab.kill();
  await new Promise((r) => collab.once('exit', r));
  collab = await startCollab(false);
  const fresh = await tab('analyst');
  await synced(fresh);
  await settle(fresh, (n) => window.__shared.nodes().length === n, before8.length);
  check('after the server restarts, a new browser gets the whole canvas from Postgres', JSON.stringify(await nodes(fresh)) === JSON.stringify(before8), `${before8.length} nodes`);

  // 5. A named version: taken by the server, from the canvas, once.
  await fresh.fill('#version-name', 'pre-CPI');
  await fresh.click('#save');
  await settle(fresh, () => document.getElementById('versions').textContent.includes('pre-CPI'));
  const listed = await fresh.locator('#versions').textContent();
  check('a named version is saved, with the dataset snapshots the nodes cite', listed.includes('pre-CPI (analyst; iceberg ice-0801)'), listed);
  await fresh.click('#save');
  await settle(fresh, () => document.getElementById('error').textContent.length > 0);
  check('the same name cannot be saved twice', (await fresh.locator('#error').textContent()).includes('a version is never replaced'));
  await fresh.screenshot({ path: `${OUT}/shared-version.png` });

  // 5b. Logout ends the session, drops the key and erases the sealed copy.
  const secretBefore = await (await fetch(`http://127.0.0.1:${COLLAB_PORT}/v1/session`, { method: 'POST', headers: { 'X-Picasso-User': 'analyst' } })).json();
  await back.click('#logout');
  await settle(back, () => window.__shared.state() === 'signed-out');
  const left = (await readDevice(back, 'picasso-offline-analyst')).keys;
  const secretAfter = await (await fetch(`http://127.0.0.1:${COLLAB_PORT}/v1/session`, { method: 'POST', headers: { 'X-Picasso-User': 'analyst' } })).json();
  check('logout erases the sealed copy, and the next session has a new secret', left === 0 && secretBefore.secret !== secretAfter.secret, `${left} records left`);

  // 6. Another tenant's canvas is refused.
  const outsider = await tab('pm', 'globex/plans');
  await settle(outsider, () => window.__shared?.state() === 'refused');
  check('a user cannot open another tenant\'s canvas', (await outsider.evaluate(() => window.__shared.state())) === 'refused' && (await nodes(outsider)).length === 0);

  check('no console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
} finally {
  server.kill();
  collab.kill();
  try {
    execFileSync('psql', [PG, '-qc', `DROP SCHEMA ${SCHEMA} CASCADE`], { stdio: 'ignore' });
  } catch {
    // left to its owner; the schema is unique to this run
  }
}
process.exit(failures > 0 ? 1 : 0);
