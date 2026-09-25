/**
 * Loads every demo page under PRD 7.2's headers and checks the policy holds in
 * a browser, where it actually has to.
 *
 * For each page: nothing the page needs was refused, `eval` is refused, an
 * injected inline script does not run, and the page is cross-origin isolated.
 * On the payoff page, WebAssembly still compiles and reprices — the check that
 * `'wasm-unsafe-eval'` is enough and `'unsafe-eval'` is not needed.
 *
 *   npm run build && node apps/canvas-demo/scripts/csp-check.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
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

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8341);
const PAGES = ['index', 'ink', 'gl', 'inkgl', 'collab', 'payoff', 'rates'];

const server = spawn(process.execPath, ['scripts/serve.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

async function waitForServer(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never came up at ${url}`);
}

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`${label.padEnd(58)} ${condition ? 'ok' : 'FAIL'}${detail ? `  ${detail}` : ''}`);
}

try {
  await waitForServer(`http://localhost:${PORT}/apps/canvas-demo/index.html`);
  const executablePath = await resolveChromium();
  const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}) });

  for (const name of PAGES) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
    const refused = [];
    const errors = [];
    page.on('console', (msg) => {
      const text = msg.text();
      if (/Content Security Policy|Refused to/i.test(text)) refused.push(text);
      else if (msg.type() === 'error') errors.push(text);
    });
    page.on('pageerror', (error) => errors.push(String(error)));

    const response = await page.goto(`http://localhost:${PORT}/apps/canvas-demo/${name}.html`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    const headers = response.headers();

    // eval is probed from a same-origin script the page runs, not from
    // page.evaluate: DevTools evaluation is exempt from CSP, and asking it
    // whether eval is refused reports "allowed" on every page.
    await page.addScriptTag({ url: '/apps/canvas-demo/csp-probe.js' });
    await page.waitForFunction(() => window.__cspEval !== undefined);
    const probe = await page.evaluate(() => {
      const evalResult = window.__cspEval;
      const functionResult = window.__cspFunction;
      const injected = document.createElement('script');
      injected.textContent = 'window.__injected = true';
      document.head.appendChild(injected);
      return {
        eval: evalResult,
        fn: functionResult,
        injectedRan: window.__injected === true,
        isolated: window.crossOriginIsolated === true,
      };
    });
    // The probes' own refusals are the point; anything else refused is a
    // page the policy broke.
    const unexpected = refused.filter((t) => !/inline script|unsafe-eval|'eval'|eval/i.test(t));
    const pageRefusals = unexpected.length;

    check(`${name}: CSP header present, no unsafe-eval`,
      /wasm-unsafe-eval/.test(headers['content-security-policy'] ?? '') &&
        !/'unsafe-eval'/.test(headers['content-security-policy'] ?? '') &&
        !/'unsafe-inline'/.test(headers['content-security-policy'] ?? ''));
    check(`${name}: nothing the page needs was refused`, pageRefusals <= 0,
      pageRefusals > 0 ? unexpected.slice(0, 2).join(' | ') : '');
    check(`${name}: no page errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    check(`${name}: eval and new Function are refused`, probe.eval === 'refused' && probe.fn === 'refused');
    check(`${name}: an injected inline script does not run`, probe.injectedRan === false);
    check(`${name}: cross-origin isolated (COOP + COEP)`, probe.isolated === true);

    if (name === 'payoff') {
      const cells = await page.evaluate(() => window.__payoff?.()?.cells.length ?? 0);
      check('payoff: WebAssembly compiled and repriced under the CSP', cells === 375, `${cells} cells`);
    }
    await page.close();
  }
  await browser.close();
} finally {
  server.kill();
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
