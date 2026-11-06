/**
 * The historical-morning page, in a real browser, with the export service.
 *
 * Runs the collaboration server (development identity, Postgres, the shipped
 * vendor rules) behind the demo server, and checks in Chromium that the series
 * chart draws what each canvas time and each reader should see, and that
 * Export PDF goes through the audit trail and comes back as a PDF whose text,
 * read by pdftotext, carries the figures and the withheld note.
 *
 *   COLLAB_PG_URL=postgres://... node apps/canvas-demo/scripts/morning-shots.mjs [outDir]
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

async function resolveChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !existsSync(base)) return undefined;
  for (const dir of (await readdir(base)).filter((d) => d.startsWith('chromium')).sort().reverse()) {
    for (const candidate of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const full = `${base}/${dir}/${candidate}`;
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

const PG = process.env.COLLAB_PG_URL;
if (!PG) {
  console.error('COLLAB_PG_URL is required');
  process.exit(1);
}
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = process.argv[2] ?? fileURLToPath(new URL('../shots', import.meta.url));
const PORT = Number(process.env.PORT ?? 8361);
const COLLAB_PORT = Number(process.env.COLLAB_PORT ?? 8764);
const SITE = `http://localhost:${PORT}`;
const SCHEMA = `morning_${Date.now().toString(36)}`;

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
}
async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never came up: ${url}`);
}

const children = [
  spawn(process.execPath, [join(ROOT, 'services/collab/dist/main.js'), '--dev-identity', '--pg', PG, '--users', join(ROOT, 'services/dataplane/config/users.json'),
    '--schema', SCHEMA, '--audit-schema', `${SCHEMA}_audit`, '--vendor-policies', join(ROOT, 'services/collab/config/vendor-policies.json'), '--migrate', '--port', String(COLLAB_PORT)],
  { stdio: ['ignore', 'ignore', 'inherit'] }),
  spawn(process.execPath, ['scripts/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), COLLAB_URL: `http://127.0.0.1:${COLLAB_PORT}` }, stdio: 'ignore' }),
];

try {
  await waitFor(`http://127.0.0.1:${COLLAB_PORT}/v1/healthz`);
  await waitFor(`${SITE}/apps/canvas-demo/morning.html`);
  await mkdir(OUT, { recursive: true });
  const executablePath = await resolveChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext({ viewport: { width: 820, height: 640 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${SITE}/apps/canvas-demo/morning.html`);
  await page.waitForFunction(() => window.__morning?.ready);
  const state = () => page.evaluate(() => ({ markers: window.__morning.markers(), gaps: window.__morning.gaps(), segments: window.__morning.segments(), values: window.__morning.values() }));
  const choose = async (id, value) => {
    await page.selectOption(`#${id}`, value);
    await page.waitForTimeout(150);
  };

  let s = await state();
  check('pinned to the morning, the chart draws the two quarters known then, June at its first figure',
    s.markers === 2 && s.gaps.length === 0 && JSON.stringify(s.values) === JSON.stringify([26.04, 30.04]), JSON.stringify(s.values));
  await page.screenshot({ path: `${OUT}/morning-pinned.png` });

  await choose('time', 'live');
  s = await state();
  check('live, the licensed reader sees every quarter, June at its latest restatement',
    s.markers === 5 && s.gaps.length === 0 && s.values[1] === 29.71, JSON.stringify(s.values));

  await choose('user', 'analyst');
  s = await state();
  check('live, the unlicensed reader sees June as a gap with its reason, and the line broken there',
    s.markers === 4 && s.gaps.length === 1 && s.gaps[0] === '2024-06-30: Requires a vendor-b licence.' && s.segments === 2 && s.values[1] === null, JSON.stringify(s));
  await page.screenshot({ path: `${OUT}/morning-withheld.png` });

  // Export as the licensed reader, live: vendor-b has no rule in the shipped policies, so June is withheld in the PDF.
  await choose('user', 'pm');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  const path = await download.path();
  const status = await page.textContent('#export-status');
  const trace = /trace ([0-9a-f]{32})/.exec(status)?.[1];
  const text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
  check('Export PDF downloads a PDF whose text has the figures, June withheld under the vendor rule, and the appendix',
    text.includes('NVDA revenue 2024-03-31: 26.04 USD bn') && text.includes('NVDA revenue 2024-06-30: withheld') && text.includes('vendor-b: no redistribution policy on file')
      && text.includes('Appendix: audit bundle') && trace !== undefined && text.includes(`export recorded under trace ${trace}`), status);
  const row = execFileSync('psql', [PG, '-tAc', `SELECT actor || '|' || action || '|' || resource || '|' || purpose || '|' || trace_id || '|' || outcome FROM ${SCHEMA}_audit.records`], { encoding: 'utf8' }).trim();
  check('and the export is on the Postgres audit trail, under the trace the PDF prints',
    row === `pm|export|dev/morning|export.pdf|${trace}|exported 5 cells, 1 redacted, within the tenant, as PDF`, row);

  check('no console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
} finally {
  for (const c of children) c.kill();
  try {
    execFileSync('psql', [PG, '-qc', `DROP SCHEMA ${SCHEMA} CASCADE; DROP SCHEMA IF EXISTS ${SCHEMA}_audit CASCADE`], { stdio: 'ignore' });
  } catch {
    // left to its owner; the schema is unique to this run
  }
}
process.exit(failures > 0 ? 1 : 0);
