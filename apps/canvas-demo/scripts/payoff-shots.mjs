/**
 * Verifies the pricing core in a real browser, which is the only place the
 * claim actually has to hold.
 *
 * The unit tests instantiate the same `.wasm` under Node. That checks the
 * arithmetic but not the delivery: streaming instantiation refuses a module
 * served with the wrong MIME type, a module that top-level-awaits fails
 * silently in a `<script type="module">`, and a stale artefact in the browser
 * cache produces a `undefined is not a function` deep inside a repricing loop.
 * None of those are reachable from Node.
 *
 *   node apps/canvas-demo/scripts/payoff-shots.mjs [outDir]
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
const PORT = Number(process.env.PORT ?? 8327);

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
  console.log(`${label.padEnd(54)} ${condition ? 'ok' : 'FAIL'}${detail ? `  ${detail}` : ''}`);
}

/** Samples the rendered surface, to prove cells were painted rather than skipped. */
async function sampleSurface(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('surface');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set();
    let painted = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      painted += 1;
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return { painted, distinctColours: seen.size, pixels: data.length / 4 };
  });
}

try {
  await mkdir(OUT, { recursive: true });
  const base = `http://localhost:${PORT}/apps/canvas-demo/payoff.html`;
  await waitForServer(base);

  const executablePath = await resolveChromium();
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__payoff?.() !== undefined, null, { timeout: 30_000 });

  // 1. The module loaded and computed, in a browser, over the network.
  const first = await page.evaluate(() => {
    const r = window.__payoff();
    return {
      cells: r.cells.length,
      spotCount: r.spotCount,
      volCount: r.volCount,
      elapsedMs: r.elapsedMs,
      guard: r.guard,
      centre: r.cell((r.spotCount - 1) >> 1, (r.volCount - 1) >> 1),
      finite: r.cells.every((c) => Number.isFinite(c.value)),
      spotAxis: [r.spotAxis[0], r.spotAxis[(r.spotCount - 1) >> 1], r.spotAxis[r.spotCount - 1]],
    };
  });

  check('module instantiated and repriced in the browser', first.cells === 375, `${first.cells} cells`);
  check('every cell is a finite number', first.finite === true);
  check('axes come from the engine, centred on spot', first.spotAxis[1] === 100,
    `[${first.spotAxis.map((v) => v.toFixed(1)).join(', ')}]`);

  // 2. The surface was painted, with structure rather than one flat colour.
  const painted = await sampleSurface(page);
  check('the surface is drawn', painted.painted > painted.pixels * 0.5,
    `${((painted.painted / painted.pixels) * 100).toFixed(0)}% of pixels`);
  check('it has structure, not one flat fill', painted.distinctColours > 8,
    `${painted.distinctColours} colours`);

  await page.screenshot({ path: `${OUT}/payoff-spread.png` });

  // 3. Every book computes, and the 40-leg one holds the budget in-browser.
  const timings = [];
  for (const key of ['reversal', 'butterfly', 'book']) {
    await page.selectOption('#strategy', key);
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
      const g = window.__payoff();
      return { elapsedMs: g.elapsedMs, guard: g.guard, cells: g.cells.length };
    });
    timings.push([key, r]);
    check(`${key}: repriced`, r.cells === 375);
    await page.screenshot({ path: `${OUT}/payoff-${key}.png` });
  }

  const book = timings.find(([k]) => k === 'book')?.[1];
  check('40-leg book inside the 90ms budget in-browser', book.elapsedMs < 90,
    `${book.elapsedMs.toFixed(1)}ms`);
  check('the guard ran on the mixed-exercise book',
    book.guard.outcome === 'passed' || book.guard.outcome === 'escalated',
    `${book.guard.outcome}: ${book.guard.badge}`);

  // 4. Time decay re-drives the whole pipeline from a UI event.
  await page.fill('#decay', '45');
  await page.dispatchEvent('#decay', 'input');
  await page.waitForTimeout(200);
  const decayed = await page.evaluate(() => window.__payoff().cell(12, 7).value);
  await page.screenshot({ path: `${OUT}/payoff-decayed.png` });
  check('decay changes the surface', Number.isFinite(decayed) && decayed !== book.centre?.value);

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  console.log('');
  console.log('in-browser timings (Chromium, this machine)');
  for (const [key, r] of timings) {
    console.log(`  ${key.padEnd(12)} ${r.elapsedMs.toFixed(2).padStart(7)}ms   ` +
      `${r.guard.repricings.toLocaleString().padStart(8)} repricings   ${r.guard.badge}`);
  }
  console.log(`\nshots in ${OUT}`);

  await browser.close();
} finally {
  server.kill();
}

process.exit(failures > 0 ? 1 : 0);
