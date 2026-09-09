/**
 * Drives two live clients in one browser and asserts they converge.
 *
 * The unit tests prove convergence against in-process Yjs documents. This runs
 * the same code in a browser, through the real renderer, and checks the thing
 * the PRD actually promises: cut the connection, keep working on both sides,
 * reconnect, and end up with one canvas.
 *
 *   node apps/canvas-demo/scripts/collab-shots.mjs [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
const PORT = Number(process.env.PORT ?? 8323);

const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

async function waitForServer(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never came up at ${url}`);
}

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`${label.padEnd(46)} ${condition ? 'ok' : 'FAIL'}${detail ? `  ${detail}` : ''}`);
}

try {
  await mkdir(OUT, { recursive: true });
  const url = `http://localhost:${PORT}/apps/canvas-demo/collab.html`;
  await waitForServer(url);

  const executablePath = await resolveChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__collab !== undefined, null, { timeout: 10_000 });
  await page.waitForTimeout(200);

  const seeded = await page.evaluate(() => ({
    counts: window.__collab.counts(),
    converged: window.__collab.converged(),
  }));
  check(
    'both clients start from the same canvas',
    seeded.converged && seeded.counts.a === seeded.counts.b && seeded.counts.a === 5,
    JSON.stringify(seeded.counts),
  );

  // A cursor is presence, not document: it should reach the other pane.
  const paneA = await page.locator('#canvas-a').boundingBox();
  await page.mouse.move(paneA.x + 200, paneA.y + 160);
  await page.mouse.move(paneA.x + 260, paneA.y + 220);
  await page.waitForTimeout(120);
  const cursors = await page.evaluate(() => window.__collab.cursors());
  check('the peer cursor reaches the other client', cursors.b?.cursor !== undefined);

  // Cut the link and let both sides work.
  await page.evaluate(() => window.__collab.setOnline('b', false));
  await page.evaluate(() => {
    window.__collab.addTo('a');
    window.__collab.addTo('a');
    window.__collab.addTo('b');
  });
  await page.waitForTimeout(150);

  const offline = await page.evaluate(() => ({
    counts: window.__collab.counts(),
    converged: window.__collab.converged(),
  }));
  check(
    'offline, each client sees only its own work',
    !offline.converged && offline.counts.a === 7 && offline.counts.b === 6,
    JSON.stringify(offline.counts),
  );
  await page.screenshot({ path: `${OUT}/collab-offline.png` });

  // Reconnect: no queue, no replay log, just a state-vector exchange.
  await page.evaluate(() => window.__collab.setOnline('b', true));
  await page.waitForTimeout(200);

  const merged = await page.evaluate(() => ({
    counts: window.__collab.counts(),
    converged: window.__collab.converged(),
  }));
  check(
    'reconnecting merges both sides with nothing lost',
    merged.converged && merged.counts.a === 8 && merged.counts.b === 8,
    JSON.stringify(merged.counts),
  );
  await page.screenshot({ path: `${OUT}/collab-merged.png` });

  if (consoleErrors.length > 0) {
    failures += 1;
    console.error(`\nconsole errors:\n${consoleErrors.join('\n')}`);
  }

  await browser.close();
  console.log(`\nwrote 2 screenshots to ${OUT}`);
} finally {
  server.kill();
}

process.exit(failures > 0 ? 1 : 0);
