/**
 * Verifies the rate branch end to end in a real browser.
 *
 * The unit tests instantiate the same `.wasm` under Node. That checks the
 * arithmetic but not the delivery: streaming instantiation refuses a module
 * served with the wrong MIME type, a module that top-level-awaits fails
 * silently in a `<script type="module">`, and a stale artefact in the browser
 * cache produces a `undefined is not a function` deep inside a repricing loop.
 * None of those are reachable from Node.
 *
 *   node apps/canvas-demo/scripts/rates-shots.mjs [outDir]
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
const PORT = Number(process.env.PORT ?? 8329);

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
  const base = `http://localhost:${PORT}/apps/canvas-demo/rates.html`;
  await waitForServer(base);

  const executablePath = await resolveChromium();
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1320, height: 820 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__rates?.() !== undefined, null, { timeout: 40_000 });

  const read = () =>
    page.evaluate(() => {
      const s = window.__rates();
      return {
        rateMoveBps: s.rateMoveBps,
        elapsedMs: s.elapsedMs,
        shock: s.shock,
        rows: s.rows,
        assumptions: s.assumptions,
        weak: s.weak,
        dv01: s.dv01,
      };
    });

  // 1. The whole chain ran: curve, regression, transmission, two grids.
  const flattener = await read();
  check('curve, shock and book all computed', flattener.rows.length === 2);
  check('the shock moved the pricing tenor', Math.abs(flattener.rateMoveBps) > 1,
    `${flattener.rateMoveBps.toFixed(1)}bp at 1y`);
  check('both names moved through their betas',
    flattener.rows.every((r) => r.spotMovePct !== 0 && r.volShift !== 0));
  check('both books repriced',
    flattener.rows.every((r) => Number.isFinite(r.before) && r.before !== r.after));
  check('a 10y DV01 came off the same curve', flattener.dv01 > 0.05 && flattener.dv01 < 0.12,
    flattener.dv01.toFixed(4));

  // 2. The claim the page exists to make: one name is trusted, one is not.
  // The PRD's claim is about the *spot* mapping per name — "NVDA's is 0.31 over
  // the trailing two years, AVGO's is 0.11". Vol-to-rates is a weaker
  // relationship for both names, and the page saying so is the estimator being
  // honest rather than a bug.
  const spotWeak = flattener.weak.filter((line) => line.includes('spot-to-rates'));
  check('one name\'s spot beta is trusted and the other is not', spotWeak.length === 1,
    flattener.weak.join(' | '));
  check('the flagged line names its R-squared',
    flattener.assumptions.some((a) => a.includes('treat as an assumption') && a.includes('R²')));
  check('the trusted name is not flagged',
    flattener.assumptions.some((a) => a.includes('NVDA') && !a.includes('treat as an assumption')));

  // 3. The chart drew, with structure.
  const painted = await page.evaluate(() => {
    const canvas = document.getElementById('chart');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set();
    let painted = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      painted += 1;
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return { painted, colours: seen.size, pixels: data.length / 4 };
  });
  check('the curve chart is drawn', painted.painted > painted.pixels * 0.02,
    `${((painted.painted / painted.pixels) * 100).toFixed(0)}% of pixels`);
  check('both curves and the quotes are distinguishable', painted.colours > 5,
    `${painted.colours} colours`);
  await page.screenshot({ path: `${OUT}/rates-flattener.png` });

  // 4. Shock shape actually changes the transmission.
  await page.selectOption('#shape', 'parallel');
  await page.waitForTimeout(400);
  const parallel = await read();
  check('a parallel shift moves the front end more than a flattener does',
    Math.abs(parallel.rateMoveBps) > Math.abs(flattener.rateMoveBps),
    `parallel ${parallel.rateMoveBps.toFixed(1)}bp vs flattener ${flattener.rateMoveBps.toFixed(1)}bp`);
  await page.screenshot({ path: `${OUT}/rates-parallel.png` });

  // 5. Reversing the shock reverses the book.
  await page.fill('#bps', '-50');
  await page.dispatchEvent('#bps', 'input');
  await page.waitForTimeout(400);
  const rally = await read();
  const pnl = (s) => s.rows.reduce((t, r) => t + (r.after - r.before), 0);
  check('a rally moves the book the other way', Math.sign(pnl(rally)) !== Math.sign(pnl(parallel)),
    `selloff ${pnl(parallel).toFixed(0)} vs rally ${pnl(rally).toFixed(0)}`);
  await page.screenshot({ path: `${OUT}/rates-rally.png` });

  check('inside a frame budget for dragging', parallel.elapsedMs < 400,
    `${parallel.elapsedMs.toFixed(0)}ms for 40 legs across 2 grids`);
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  console.log('');
  console.log('the chain, as the page computed it');
  console.log(`  shock            ${flattener.shock.bps}bp ${flattener.shock.shape} at ${flattener.shock.pivot}y`);
  console.log(`  rate at 1y       ${flattener.rateMoveBps.toFixed(1)}bp`);
  for (const r of flattener.rows) {
    console.log(
      `  ${r.ticker.padEnd(6)} spot ${(r.spotMovePct * 100).toFixed(2)}%  ` +
        `vol ${(r.volShift * 100).toFixed(2)}pts  ` +
        `book ${(r.after - r.before >= 0 ? '+' : '')}${(r.after - r.before).toFixed(0)}`,
    );
  }
  for (const line of flattener.assumptions) console.log(`  · ${line}`);
  console.log(`\nshots in ${OUT}`);

  await browser.close();
} finally {
  server.kill();
}

process.exit(failures > 0 ? 1 : 0);
