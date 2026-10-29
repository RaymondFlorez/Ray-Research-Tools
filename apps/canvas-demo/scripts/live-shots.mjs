/**
 * Drives live tiles against the real Go data plane in a real browser.
 *
 * Builds services/dataplane, replays a recording through it — synthetic, made
 * here, and labelled as such on every tile — and checks what the PRD says a
 * live tile must do: show a licensed series only to a licensed user, hold the
 * 4Hz cap, say "recovering" after a sequence gap, and say "stale" with the
 * elapsed time when the feed stops, instead of freezing a number.
 *
 *   node apps/canvas-demo/scripts/live-shots.mjs [outDir]
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = process.argv[2] ?? fileURLToPath(new URL('../shots', import.meta.url));
const PORT = Number(process.env.PORT ?? 8330);
const DP_PORT = Number(process.env.DP_PORT ?? 8741);

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
}

async function waitFor(url, headers = {}, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url, { headers })).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never came up: ${url}`);
}

// A synthetic recording, not market data: eight seconds of NVDA (channel eq1,
// public) and AMD (channel eq2, licensed), a hundred messages a second each,
// with three AMD messages missing at four seconds. Then the feed stops.
const work = await mkdtemp(join(tmpdir(), 'live-shots-'));
const recording = join(work, 'synthetic-feed.ndjson');
const lines = [];
const seq = { eq1: 0, eq2: 0 };
for (let ms = 0; ms < 8_000; ms += 10) {
  for (const [sym, channel] of [['NVDA', 'eq1'], ['AMD', 'eq2']]) {
    seq[channel] += 1;
    if (channel === 'eq2' && ms === 4_000) seq[channel] += 3;
    lines.push(JSON.stringify({ feed: 'feed-a', channel, seq: seq[channel], offsetMs: ms, payload: { sym, t: ms, f: { price: (sym === 'NVDA' ? 120 : 150) + ms / 1000, size: 1 } } }));
  }
}
await writeFile(recording, `${lines.join('\n')}\n`);

const binary = join(work, 'dataplane');
execFileSync('go', ['build', '-o', binary, './cmd/dataplane'], { cwd: join(ROOT, 'services/dataplane'), stdio: 'inherit' });
const config = join(ROOT, 'services/dataplane/config');

const children = [];
try {
  await mkdir(OUT, { recursive: true });
  const executablePath = await resolveChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 900, height: 420 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATAPLANE_URL: `http://127.0.0.1:${DP_PORT}` }, stdio: 'ignore' });
  children.push(server);
  await waitFor(`http://localhost:${PORT}/apps/canvas-demo/live.html`);

  // Start the feed, then open the page straight away: the recording runs eight seconds.
  const dataplane = spawn(binary, ['-addr', `127.0.0.1:${DP_PORT}`, '-dev-identity', '-users', `${config}/users.json`, '-symbology', `${config}/symbology.json`, '-replay', recording, '-speed', '1', '-stale-after', '1s'], { stdio: 'ignore' });
  children.push(dataplane);
  await waitFor(`http://127.0.0.1:${DP_PORT}/healthz`);
  const started = Date.now();
  await page.goto(`http://localhost:${PORT}/apps/canvas-demo/live.html`, { waitUntil: 'load' });

  const tiles = () => page.evaluate(() => window.__live.tiles());
  const byId = async () => Object.fromEntries((await tiles()).map((t) => [t.instrument, t]));

  // 1. As the analyst: NVDA live, AMD blocked, the 4Hz cap held.
  await page.waitForFunction(() => window.__live.tiles()[0].kind === 'value', null, { timeout: 5_000 });
  let t = await byId();
  check('the feed is named on the page as what it is', (await page.evaluate(() => window.__live.feed())) === 'replay of synthetic-feed.ndjson');
  check('analyst: NVDA shows a live value', t.NVDA.kind === 'value' && t.NVDA.state === 'live', `${t.NVDA.values?.price}`);
  check('analyst: AMD is blocked, with the reason, and no number', t.AMD.kind === 'blocked' && t.AMD.reason === 'Requires a vendor-b licence.' && t.AMD.values === undefined);
  const u0 = await page.evaluate(() => window.__live.updates());
  await page.waitForTimeout(1_000);
  const u1 = await page.evaluate(() => window.__live.updates());
  check('one series at 100 ticks a second arrives at no more than 4 updates a second', u1 - u0 >= 2 && u1 - u0 <= 5, `${u1 - u0} in 1s`);
  const caption = await page.locator('.tile[data-kind="value"] .caption').first().textContent();
  check('the tile\'s caption carries its source and age, through present()', caption.startsWith('replay of synthetic-feed.ndjson · live'), caption);
  await page.screenshot({ path: `${OUT}/live-analyst.png` });

  // 2. As the PM: AMD appears; after the gap on its channel it says recovering.
  await page.selectOption('#user', 'pm');
  await page.waitForFunction(() => window.__live.tiles()[1].kind === 'value', null, { timeout: 5_000 });
  check('pm: AMD shows a value once licensed', (await byId()).AMD.kind === 'value');
  await page.waitForFunction(() => window.__live.tiles()[1].state === 'recovering', null, { timeout: 6_000 });
  t = await byId();
  check('after a sequence gap AMD says recovering, with the gap', t.AMD.state === 'recovering' && /sequence gap \d+-\d+ on eq2/.test(t.AMD.reason ?? ''), t.AMD.reason);
  check('NVDA, on another channel, is unaffected', t.NVDA.state === 'live');

  // 3. The feed stops: NVDA goes stale with its age, AMD stays recovering.
  await page.waitForFunction(() => window.__live.tiles()[0].state === 'stale', null, { timeout: 12_000 });
  await page.waitForTimeout(1_200);
  t = await byId();
  const stale = await page.locator('.tile.stale .caption').first().textContent();
  check('when the feed stops NVDA says stale data, and how old', t.NVDA.state === 'stale' && t.NVDA.elapsedMs > 1_000 && /· \d+s old · stale data$/.test(stale), stale);
  const a = (await byId()).NVDA.elapsedMs;
  await page.waitForTimeout(1_100);
  const b = (await byId()).NVDA.elapsedMs;
  check('its age keeps counting rather than freezing', b - a >= 900, `${a} -> ${b}`);
  check('AMD still says recovering: a gap is not cleared by silence', t.AMD.state === 'recovering');
  await page.screenshot({ path: `${OUT}/live-stale.png` });
  console.log(`  (feed ran ${((Date.now() - started) / 1000).toFixed(1)}s into the check)`);

  if (errors.length > 0) check('no console errors', false, errors.join(' | '));
  await browser.close();
} finally {
  for (const c of children) c.kill();
}
process.exit(failures > 0 ? 1 : 0);
