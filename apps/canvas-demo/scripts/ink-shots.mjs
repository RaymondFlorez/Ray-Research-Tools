/**
 * Drives the ink surface with real pointer input in a real browser.
 *
 * The unit tests feed the recognizer synthetic point arrays. This exercises the
 * layer underneath them: pointer events, coalesced sampling, the append-only
 * builder, commit-time simplification, the 300ms scheduler, and grouping — then
 * asserts that what the recognizer saw at the end of that pipeline is the shape
 * the mouse actually drew.
 *
 *   node apps/canvas-demo/scripts/ink-shots.mjs [outDir]
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
const PORT = Number(process.env.PORT ?? 8322);

/** Hand wobble, so the mouse does not draw a machine-perfect shape. */
function wobble(points, amplitude = 2.2) {
  return points.map((p, i) => ({
    x: p.x + Math.sin(i * 0.7) * amplitude,
    y: p.y + Math.cos(i * 0.9) * amplitude,
  }));
}

function interpolate(vertices, step = 6) {
  const out = [];
  for (let i = 1; i < vertices.length; i++) {
    const a = vertices[i - 1];
    const b = vertices[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(2, Math.round(length / step));
    for (let s = 0; s < steps; s++) {
      out.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
    }
  }
  out.push(vertices[vertices.length - 1]);
  return out;
}

function ellipsePath(cx, cy, rx, ry, steps = 56) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 1.97;
    out.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
  }
  return out;
}

/** One stroke per entry: a shape can be drawn in several. */
const CASES = [
  {
    name: 'ink-rectangle',
    expect: 'rectangle',
    strokes: [
      wobble(interpolate([
        { x: 260, y: 200 }, { x: 700, y: 200 }, { x: 700, y: 480 },
        { x: 260, y: 480 }, { x: 268, y: 208 },
      ])),
    ],
  },
  {
    name: 'ink-ellipse',
    expect: 'ellipse',
    strokes: [wobble(ellipsePath(500, 340, 230, 140))],
  },
  {
    name: 'ink-arrow',
    expect: 'arrow',
    strokes: [
      wobble(interpolate([
        { x: 240, y: 340 }, { x: 720, y: 340 },
        { x: 640, y: 285 }, { x: 720, y: 340 }, { x: 640, y: 395 },
      ])),
    ],
  },
  {
    name: 'ink-line',
    expect: 'line',
    strokes: [wobble(interpolate([{ x: 250, y: 260 }, { x: 760, y: 430 }]))],
  },
  {
    name: 'ink-rectangle-four-strokes',
    expect: 'rectangle',
    strokes: [
      wobble(interpolate([{ x: 300, y: 220 }, { x: 700, y: 220 }])),
      wobble(interpolate([{ x: 700, y: 222 }, { x: 700, y: 470 }])),
      wobble(interpolate([{ x: 698, y: 470 }, { x: 302, y: 470 }])),
      wobble(interpolate([{ x: 300, y: 468 }, { x: 300, y: 222 }])),
    ],
  },
];

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
try {
  await mkdir(OUT, { recursive: true });
  const url = `http://localhost:${PORT}/apps/canvas-demo/ink.html`;
  await waitForServer(url);

  const executablePath = await resolveChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto(url, { waitUntil: 'load' });

  for (const testCase of CASES) {
    await page.evaluate(() => window.__ink.clear());

    for (const stroke of testCase.strokes) {
      await page.mouse.move(stroke[0].x, stroke[0].y);
      await page.mouse.down();
      for (const point of stroke.slice(1)) await page.mouse.move(point.x, point.y);
      await page.mouse.up();
    }

    // Wait for every stroke to land, then for the scheduler's delay to pass.
    // Reading at the first non-null result would race: driving the mouse point
    // by point takes longer than the recognition delay, so a multi-stroke shape
    // recognizes once per stroke on the way and only settles at the end.
    await page.waitForFunction(
      (expected) => window.__ink.strokeCount() === expected,
      testCase.strokes.length,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(600);
    const result = await page.evaluate(() => window.__ink.result());
    const strokeCount = await page.evaluate(() => window.__ink.strokeCount());
    await page.screenshot({ path: `${OUT}/${testCase.name}.png` });

    const ok = result.kind === testCase.expect;
    if (!ok) failures += 1;
    console.log(
      `${testCase.name.padEnd(30)} ${String(strokeCount).padStart(2)} stroke(s) -> ` +
        `${result.kind.padEnd(10)} conf ${result.confidence.toFixed(2)}  ` +
        `${ok ? 'ok' : `FAIL (expected ${testCase.expect})`}`,
    );
  }

  if (consoleErrors.length > 0) {
    failures += 1;
    console.error(`\nconsole errors:\n${consoleErrors.join('\n')}`);
  }

  await browser.close();
  console.log(`\nwrote ${CASES.length} screenshots to ${OUT}`);
} finally {
  server.kill();
}

process.exit(failures > 0 ? 1 : 0);
