/**
 * Drives the demo in a real browser and captures one frame per LOD.
 *
 * This is the check that the draw list actually draws: it asserts on the scene
 * stats the page reports (what was culled, which LOD committed, how many nodes
 * the DOM layer would mount) and fails on any console error, then writes a PNG
 * per zoom level so the binding signatures can be eyeballed.
 *
 *   node apps/canvas-demo/scripts/screenshot.mjs [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Use the Chromium the environment already ships rather than downloading one.
 * Playwright pins an exact build number per release, so a mismatch between the
 * installed browser and the installed library is normal here; pointing at the
 * binary avoids a download that the sandbox would refuse anyway.
 */
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
const PORT = Number(process.env.PORT ?? 8321);
const NODES = Number(process.env.NODES ?? 2000);

/** Zoom levels chosen to land one frame in each LOD band. */
const SHOTS = [
  { name: 'lod0-overview', scale: 0.08, expectLod: 0 },
  { name: 'lod1-tiles', scale: 0.3, expectLod: 1 },
  { name: 'lod2-nodes', scale: 0.75, expectLod: 2 },
  { name: 'lod3-detail', scale: 2.5, expectLod: 3 },
];

async function waitForServer(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never came up at ${url}`);
}

const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

let failures = 0;
try {
  await mkdir(OUT, { recursive: true });
  await waitForServer(`http://localhost:${PORT}/apps/canvas-demo/index.html`);

  const executablePath = await resolveChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  for (const shot of SHOTS) {
    const url = `http://localhost:${PORT}/apps/canvas-demo/index.html?nodes=${NODES}&scale=${shot.scale}&now=1000`;
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__picasso?.stats() !== null, null, { timeout: 10_000 });
    // Let a few frames run so the LOD tracker commits and the HUD settles.
    await page.waitForTimeout(400);

    const report = await page.evaluate(() => ({
      stats: window.__picasso.stats(),
      lod: window.__picasso.lod(),
      mounted: window.__picasso.mounted(),
    }));

    const { stats, lod, mounted } = report;
    const problems = [];
    if (lod !== shot.expectLod) problems.push(`expected LOD${shot.expectLod}, committed LOD${lod}`);
    if (!stats || stats.nodesTotal !== NODES) problems.push(`expected ${NODES} nodes, saw ${stats?.nodesTotal}`);
    if (stats && stats.nodesDrawn === 0) problems.push('nothing was drawn');
    if (stats && stats.nodesDrawn > stats.nodesTotal) problems.push('drew more than exists');
    // Only LOD2 and above mount DOM.
    if (shot.expectLod < 2 && mounted !== 0) problems.push(`LOD${lod} should mount no DOM, wanted ${mounted}`);
    if (shot.expectLod >= 2 && mounted === 0) problems.push(`LOD${lod} should mount DOM, wanted none`);

    await page.screenshot({ path: `${OUT}/${shot.name}.png` });

    const verdict = problems.length === 0 ? 'ok' : `FAIL (${problems.join('; ')})`;
    failures += problems.length === 0 ? 0 : 1;
    console.log(
      `${shot.name.padEnd(16)} zoom ${String(shot.scale).padEnd(5)} LOD${lod} ` +
        `drawn ${String(stats?.nodesDrawn).padStart(5)}/${stats?.nodesTotal} ` +
        `edges ${String(stats?.edgesDrawn).padStart(5)}/${stats?.edgesTotal} ` +
        `scene ${stats?.buildMs.toFixed(2)}ms mount ${String(mounted).padStart(4)} ${verdict}`,
    );
  }

  if (consoleErrors.length > 0) {
    failures += 1;
    console.error(`\nconsole errors:\n${consoleErrors.join('\n')}`);
  }

  await browser.close();
  console.log(`\nwrote ${SHOTS.length} screenshots to ${OUT}`);
} finally {
  server.kill();
}

process.exit(failures > 0 ? 1 : 0);
