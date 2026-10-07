/**
 * Drives the tools surface (PRD 3.2.3) in a real browser, with mouse, pen and
 * touch input, and checks the table row by row — and the sentence above it:
 * switching tools "never changes what is visible".
 *
 *   node apps/canvas-demo/scripts/tools-shots.mjs [outDir]
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
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
}

try {
  await mkdir(OUT, { recursive: true });
  const url = `http://localhost:${PORT}/apps/canvas-demo/tools.html`;
  await waitForServer(url);
  const executablePath = await resolveChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
  const consoleErrors = [];
  page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__tools && window.__tools.scene() !== '');

  const state = () => page.evaluate(() => window.__tools.state());
  const doc = () => page.evaluate(() => window.__tools.doc());
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const portAt = (nodeId, portId) => page.evaluate(([n, p]) => window.__tools.portAt(n, p), [nodeId, portId]);

  /** A synthetic pointer of any type, through the same listeners a real one reaches. */
  async function pointer(type, id, kind, x, y) {
    await page.evaluate(
      ([type, id, kind, x, y]) => {
        document.getElementById('canvas').dispatchEvent(
          new PointerEvent(type, { pointerId: id, pointerType: kind, clientX: x, clientY: y, bubbles: true, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1 }),
        );
      },
      [type, id, kind, x, y],
    );
  }
  async function drag(kind, id, from, to, steps = 8) {
    await pointer('pointerdown', id, kind, from.x, from.y);
    for (let i = 1; i <= steps; i += 1) {
      await pointer('pointermove', id, kind, from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    }
    await pointer('pointerup', id, kind, to.x, to.y);
  }

  // 1. Switching tools changes nothing that is drawn.
  await frame();
  const before = await page.evaluate(() => window.__tools.scene());
  const seen = [];
  for (const key of ['p', 'w', 'c', 't', 'Shift+T', 'v']) {
    await page.keyboard.press(key);
    await frame();
    seen.push((await state()).selected);
    const now = await page.evaluate(() => window.__tools.scene());
    if (now !== before) check(`scene unchanged after ${key}`, false);
  }
  check('V P W C T Shift-T select the five tools', seen.join(' ') === 'pen wire causal text text pointer', seen.join(' '));
  check('the drawn scene is byte-identical across every tool switch', (await page.evaluate(() => window.__tools.scene())) === before);

  // 2. Pointer: a mouse drag on a node moves it.
  const start = (await doc()).nodes.find((n) => n.id === 'monthly');
  await page.mouse.move(580, 360);
  await page.mouse.down();
  await page.mouse.move(600, 380, { steps: 5 });
  await page.mouse.up();
  const moved = (await doc()).nodes.find((n) => n.id === 'monthly');
  check('V: a mouse drag moves the node', moved.x - start.x === 20 && moved.y - start.y === 20, `${moved.x - start.x}, ${moved.y - start.y}`);
  await page.mouse.move(580 + 20, 360 + 20);
  await page.mouse.down();
  await page.mouse.move(580, 360, { steps: 5 });
  await page.mouse.up();

  // 3. A stylus inks over a node with the pointer chosen, and hands the pointer back.
  await page.keyboard.press('v');
  const nodesBefore = JSON.stringify((await doc()).nodes);
  await pointer('pointerdown', 7, 'pen', 560, 100);
  const during = await state();
  // The palm lands while the pen is down, and is refused.
  await pointer('pointerdown', 8, 'touch', 700, 500);
  await pointer('pointermove', 8, 'touch', 760, 540);
  await pointer('pointerup', 8, 'touch', 760, 540);
  for (let i = 1; i <= 10; i += 1) await pointer('pointermove', 7, 'pen', 560 + i * 8, 100 + i * 4);
  await pointer('pointerup', 7, 'pen', 640, 140);
  const after = await state();
  const counts = await page.evaluate(() => window.__tools.counts());
  check('stylus contact takes the pen; lift gives the pointer back', during.active === 'pen' && during.selected === 'pointer' && after.active === 'pointer', `${during.active}/${after.active}`);
  check('the stylus inked over a node and moved nothing', counts.strokes === 1 && JSON.stringify((await doc()).nodes) === nodesBefore);
  check('the palm was refused while the pen was down', after.palms === 1);
  // A finger with no pen down is a pointer like any other, and never switches the tool.
  await pointer('pointerdown', 9, 'touch', 580, 100);
  check('a finger never switches the tool', (await state()).active === 'pointer');
  await pointer('pointerup', 9, 'touch', 580, 100);

  // 4. Wire: from a port, the targets light up, a mismatch is refused, a match connects.
  await page.keyboard.press('w');
  const px = await portAt('prices', 'px');
  const dailyIn = await portAt('daily', 'in');
  const monthlyIn = await portAt('monthly', 'in');
  await page.mouse.move(px.x, px.y);
  await page.mouse.down();
  await page.mouse.move(px.x + 40, px.y + 10, { steps: 3 });
  const lit = (await state()).targets.map((t) => `${t.nodeId}/${t.portId}`);
  check('W: dragging from a port lights up exactly the compatible inputs', lit.join(',') === 'daily/in', lit.join(','));
  await frame();
  await page.screenshot({ path: `${OUT}/tools-wire-drag.png` });
  await page.mouse.move(monthlyIn.x, monthlyIn.y, { steps: 6 });
  await page.mouse.up();
  const refusal = await page.evaluate(() => window.__tools.outcome());
  check('W: a daily series dropped on a monthly input is refused, with the reason', refusal.startsWith('refused') && (await doc()).edges.length === 0, refusal);
  await page.mouse.move(px.x, px.y);
  await page.mouse.down();
  await page.mouse.move(dailyIn.x, dailyIn.y, { steps: 8 });
  await page.mouse.up();
  const edges = (await doc()).edges;
  check('W: dropped on a compatible input, it is a data edge', edges.length === 1 && edges[0].class === 'data' && edges[0].to === 'daily/in');
  // From empty space, an annotation arrow, not an edge.
  await page.mouse.move(300, 560);
  await page.mouse.down();
  await page.mouse.move(420, 600, { steps: 4 });
  await page.mouse.up();
  check('W: from empty space it draws an annotation arrow', (await page.evaluate(() => window.__tools.outcome())).startsWith('annotation arrow') && (await doc()).edges.length === 1);

  // 5. Causal: node to node, and the editor opens.
  await page.keyboard.press('c');
  await page.mouse.move(150, 440);
  await page.mouse.down();
  await page.mouse.move(560, 120, { steps: 8 });
  await page.mouse.up();
  const causal = await page.evaluate(() => window.__tools.counts());
  check('C: node to node is a causal edge, and the parameter editor opens', causal.causalEditorFor === 'rates->daily', String(causal.causalEditorFor));

  // 6. Text: T a loose sticky, Shift T a bound TextPad; a T typed into a field is a letter.
  await page.keyboard.press('t');
  await page.mouse.click(820, 520);
  await page.keyboard.press('Shift+T');
  await page.mouse.click(820, 380);
  const notes = (await doc()).nodes.filter((n) => n.id.startsWith('note-')).map((n) => n.binding);
  check('T makes a loose sticky, Shift T a bound TextPad', notes.join(',') === 'loose,bound', notes.join(','));
  await page.keyboard.press('v');
  await page.click('#field');
  await page.keyboard.type('pwct');
  check('keys typed into a field are text, not tools', (await state()).selected === 'pointer');

  await frame();
  await page.screenshot({ path: `${OUT}/tools-final.png` });
  if (consoleErrors.length > 0) check('no console errors', false, consoleErrors.join(' | '));
  await browser.close();
} finally {
  server.kill();
}
process.exit(failures > 0 ? 1 : 0);
