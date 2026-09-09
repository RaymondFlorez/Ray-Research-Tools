/**
 * Verifies the WebGL path in a real browser, and measures the Phase 0 target.
 *
 * Three things are checked, in decreasing order of how much they mean:
 *
 * 1. **Draw calls.** Two, whatever the node count. This is the architectural
 *    claim and it is hardware-independent.
 * 2. **Correctness.** A pixel inside a known node comes back the node's fill
 *    colour, which is the only way to know the shaders drew rather than
 *    silently producing an empty frame.
 * 3. **Frame time.** Reported, not asserted as a hardware result: this runs on
 *    SwiftShader, a CPU rasterizer, so the number is a software-rendering floor
 *    and says nothing about a real GPU. What it does bound is the CPU half —
 *    scene assembly, packing, upload — which is the part this code controls.
 *
 *   node apps/canvas-demo/scripts/gl-shots.mjs [outDir]
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
const PORT = Number(process.env.PORT ?? 8324);

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
  console.log(`${label.padEnd(52)} ${condition ? 'ok' : 'FAIL'}${detail ? `  ${detail}` : ''}`);
}

async function measure(page, url, settleMs = 2_500) {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__gl?.stats() !== null, null, { timeout: 20_000 });
  // Let the first frames (shader compile, buffer growth) fall out of the sample.
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__gl.reset());
  await page.waitForTimeout(settleMs);
  return page.evaluate(() => ({ stats: window.__gl.stats(), timings: window.__gl.timings() }));
}

try {
  await mkdir(OUT, { recursive: true });
  const base = `http://localhost:${PORT}/apps/canvas-demo/gl.html`;
  await waitForServer(base);

  const executablePath = await resolveChromium();
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  const renderer = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  }).catch(() => 'unknown');
  console.log(`renderer: ${renderer}\n`);

  // --- Correctness: does a node land on screen, in its own colour?
  // Reading a fixed point would only prove something is drawn *somewhere*, so
  // the page reports where a node actually is and what fill it should have.
  await page.goto(`${base}?nodes=40&scale=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__gl?.stats() !== null, null, { timeout: 20_000 });
  await page.waitForTimeout(200);

  const sample = await page.evaluate(() => window.__gl.sampleNode());
  check('the page can point at a drawn node', sample !== null);

  const pixel = await page.evaluate((s) => window.__gl.probe(s.x, s.y), sample);
  const expected = sample.fill
    .replace('#', '')
    .match(/../g)
    .map((h) => parseInt(h, 16));
  const close = expected.every((channel, i) => Math.abs(channel - pixel[i]) <= 4);
  check(
    'the probed pixel is the node fill, so the shaders really drew it',
    close && pixel[3] > 0,
    `got rgba(${pixel.join(',')}) want ${sample.fill}`,
  );

  // --- The Phase 0 target: 5,000 nodes, all on screen.
  const results = [];
  for (const nodes of [500, 2_000, 5_000, 10_000]) {
    const scale = nodes >= 5_000 ? 0.05 : 0.08;
    const report = await measure(page, `${base}?nodes=${nodes}&scale=${scale}`);
    results.push({ nodes, ...report });
    console.log(
      `${String(nodes).padStart(6)} nodes  drawn ${String(report.stats.nodeInstances).padStart(6)}` +
        `  edges ${String(report.stats.edgeInstances).padStart(5)}` +
        `  draws ${report.stats.drawCalls}` +
        `  pack ${report.stats.packMs.toFixed(2)}ms` +
        `  upload ${(report.stats.uploadedBytes / 1024).toFixed(0)}KB` +
        `  frame p50 ${report.timings.p50.toFixed(1)}ms p95 ${report.timings.p95.toFixed(1)}ms`,
    );
    if (nodes === 5_000) await page.screenshot({ path: `${OUT}/gl-5000-nodes.png` });
  }

  console.log('');
  const everyFrameTwoDraws = results.every((r) => r.stats.drawCalls === 2);
  check('draw calls stay at two from 500 to 10,000 nodes', everyFrameTwoDraws);

  const target = results.find((r) => r.nodes === 5_000);
  check(
    'all 5,000 nodes reach the GPU as instances',
    target.stats.nodeInstances === 5_000,
    `${target.stats.nodeInstances}`,
  );

  // The CPU half is what this code controls, and it must leave room for
  // everything else in a 16ms frame.
  check(
    'CPU packing stays well inside the frame budget at 5,000 nodes',
    target.stats.packMs < 3,
    `${target.stats.packMs.toFixed(2)}ms`,
  );

  const smallest = results[0];
  const growth = target.timings.p50 / Math.max(0.01, smallest.timings.p50);
  console.log(
    `\nframe time from ${smallest.nodes} to ${target.nodes} nodes (10x): ${growth.toFixed(1)}x` +
      `  — software rasterizer, so this is fill rate, not per-node cost`,
  );

  if (consoleErrors.length > 0) {
    failures += 1;
    console.error(`\nconsole errors:\n${consoleErrors.join('\n')}`);
  }

  await browser.close();
  console.log(`\nwrote screenshots to ${OUT}`);
} finally {
  server.kill();
}

process.exit(failures > 0 ? 1 : 0);
