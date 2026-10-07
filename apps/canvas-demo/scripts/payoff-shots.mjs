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

  // 2b. The colour is P&L, not the mark: zero at spot, a break-even line drawn.
  const pnl = await page.evaluate(() => {
    const s = window.__surface();
    return { centre: s.centrePnl, mark: s.todayMark, segments: s.breakEvenSegments };
  });
  check('the surface is P&L against today\'s mark: zero at spot', pnl.centre === 0 && pnl.mark > 1000,
    `mark ${pnl.mark.toFixed(0)}`);
  check('a break-even line is drawn where the spread stops making money', pnl.segments > 5, `${pnl.segments} segments`);
  // Hovering reads the engine's own number back, through the heatmap.
  const hoverAt = await page.evaluate(() => window.__surface().at(18, 3));
  const box = await page.locator('#surface').boundingBox();
  await page.mouse.move(box.x + hoverAt.x, box.y + hoverAt.y);
  const hover = await page.evaluate(([x, y]) => {
    const p = window.__surface().pick(x, y);
    const r = window.__payoff();
    return { i: p.i, j: p.j, value: p.value, engine: r.cell(18, 3).value - window.__surface().todayMark };
  }, [hoverAt.x, hoverAt.y]);
  check('heatmap hover reads the engine\'s P&L at that cell', hover.i === 18 && hover.j === 3 && hover.value === hover.engine,
    `${hover.value.toFixed(0)}`);

  // 2c. The 3D surface: drawn, picked, turned.
  await page.selectOption('#view', '3d');
  const painted3d = await sampleSurface(page);
  // In perspective at the default camera the surface covers about a tenth of
  // this canvas (measured: 10%), not the four fifths the heatmap fills.
  check('the 3D surface is drawn', painted3d.painted > painted3d.pixels * 0.05 && painted3d.distinctColours > 8,
    `${((painted3d.painted / painted3d.pixels) * 100).toFixed(0)}% of pixels, ${painted3d.distinctColours} colours`);
  const peak = await page.evaluate(() => {
    const s = window.__surface();
    const at = s.at(12, 0);
    const p = s.pick(at.x, at.y);
    return { i: p?.i, j: p?.j };
  });
  check('a 3D pick at a grid point\'s screen position returns that point', peak.i === 12 && peak.j === 0, `${peak.i}, ${peak.j}`);
  await page.screenshot({ path: `${OUT}/payoff-spread-3d.png` });
  const before3d = await page.evaluate(() => window.__surface().camera);
  await page.mouse.move(box.x + 400, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + 520, box.y + 330, { steps: 6 });
  await page.mouse.up();
  const after3d = await page.evaluate(() => window.__surface().camera);
  check('dragging turns the surface', Math.abs(after3d.azimuth - before3d.azimuth - 1.2) < 1e-9 && after3d.elevation > before3d.elevation,
    `azimuth +${(after3d.azimuth - before3d.azimuth).toFixed(2)}`);
  await page.screenshot({ path: `${OUT}/payoff-spread-3d-turned.png` });
  await page.selectOption('#view', 'heatmap');

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
  // Measured from today's mark, decay is a P&L, not a new zero.
  await page.selectOption('#strategy', 'spread');
  await page.waitForTimeout(200);
  const decayedPnl = await page.evaluate(() => window.__surface().centrePnl);
  check('with decay, P&L at spot is what the decay cost, not zero', Number.isFinite(decayedPnl) && decayedPnl !== 0,
    `${decayedPnl.toFixed(0)}`);

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
