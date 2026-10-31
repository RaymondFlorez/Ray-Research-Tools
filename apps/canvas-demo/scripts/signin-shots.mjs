/**
 * Signing in, in a real browser, with no development identity anywhere.
 *
 * Runs a STAND-IN OpenID provider (services/auth/dist/standin.js: it approves
 * whoever `login_hint` names, with that user's configured factors), picasso-auth
 * against it, and the collaboration server with --auth-url and without
 * --dev-identity, all behind the demo server. Then signs in through the
 * provider in Chromium, and checks what PRD 7.2 asks: a session the page cannot
 * read, a second factor required in a tenant holding positions, a typed name
 * refused, and logout that ends it.
 *
 *   COLLAB_PG_URL=postgres://... node apps/canvas-demo/scripts/signin-shots.mjs [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
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

const PG = process.env.COLLAB_PG_URL;
if (!PG) {
  console.error('COLLAB_PG_URL is required');
  process.exit(1);
}
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const OUT = process.argv[2] ?? fileURLToPath(new URL('../shots', import.meta.url));
const PORT = Number(process.env.PORT ?? 8360);
const AUTH_PORT = Number(process.env.AUTH_PORT ?? 8771);
const COLLAB_PORT = Number(process.env.COLLAB_PORT ?? 8763);
const SITE = `http://localhost:${PORT}`;
const SCHEMA = `signin_${Date.now().toString(36)}`;

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

const { startStandIn } = await import(join(ROOT, 'services/auth/dist/standin.js'));
const idp = await startStandIn({
  clientId: 'picasso-web',
  redirectUris: [`${SITE}/auth/callback`],
  users: { pm: { amr: ['pwd', 'otp'] }, loader: { amr: ['pwd', 'hwk'] }, analyst: { amr: ['pwd'] } },
});
const users = join(ROOT, 'services/dataplane/config/users.json');
const children = [
  spawn(process.execPath, [join(ROOT, 'services/auth/dist/main.js'), '--public-url', SITE, '--oidc-issuer', idp.issuer, '--client-id', 'picasso-web',
    '--users', users, '--tenants', join(ROOT, 'services/auth/config/tenants.json'), '--port', String(AUTH_PORT)], { stdio: ['ignore', 'ignore', 'inherit'] }),
  spawn(process.execPath, [join(ROOT, 'services/collab/dist/main.js'), '--auth-url', SITE, '--pg', PG, '--users', users, '--schema', SCHEMA, '--migrate',
    '--port', String(COLLAB_PORT)], { stdio: ['ignore', 'ignore', 'inherit'] }),
  spawn(process.execPath, ['scripts/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), AUTH_URL: `http://127.0.0.1:${AUTH_PORT}`, COLLAB_URL: `http://127.0.0.1:${COLLAB_PORT}` }, stdio: 'ignore' }),
];

try {
  await waitFor(`http://127.0.0.1:${COLLAB_PORT}/v1/healthz`);
  await waitFor(`${SITE}/.well-known/jwks.json`);
  await mkdir(OUT, { recursive: true });
  const executablePath = await resolveChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const errors = [];
  const tab = async (name, query = '') => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 520 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
    await page.goto(`${SITE}/apps/canvas-demo/shared.html${query}`);
    return page;
  };
  const state = (p) => p.evaluate(() => window.__shared?.state());
  const signIn = async (p, user) => {
    await p.waitForFunction(() => window.__shared?.state() === 'signed-out');
    await p.fill('#hint', user);
    await p.click('#signin-go');
    await p.waitForURL(/shared\.html/);
    await p.waitForFunction(() => ['synced', 'signed-out', 'refused'].includes(window.__shared?.state()), null, { timeout: 10_000 });
  };

  // 1. Signed out until signed in.
  const pm = await tab('pm');
  await pm.waitForFunction(() => window.__shared?.state() === 'signed-out');
  check('a page with no session is signed out, and offers to sign in', await pm.isVisible('#signin'));

  // 2. Sign in through the provider: a session, synced, that the page cannot read.
  await signIn(pm, 'pm');
  check('pm signs in through the provider and the canvas syncs on the session alone', (await state(pm)) === 'synced' && (await pm.textContent('#who')).startsWith('pm'));
  check('the session cookie is HttpOnly: no script on the page can read it', !(await pm.evaluate(() => document.cookie)).includes('picasso_session'));
  await pm.click('#add');

  // 3. A second signed-in user sees the first one's work.
  const loader = await tab('loader');
  await signIn(loader, 'loader');
  await loader.waitForFunction(() => window.__shared.nodes().length >= 1, null, { timeout: 5_000 }).catch(() => {});
  check('a second user, signed in with a hardware key, syncs the same canvas', (await state(loader)) === 'synced' && (await loader.evaluate(() => window.__shared.nodes().length)) === 1);
  await pm.screenshot({ path: `${OUT}/signin-pm.png` });

  // 4. A password alone, in a tenant that holds positions.
  const analyst = await tab('analyst');
  await signIn(analyst, 'analyst');
  const refusal = await analyst.textContent('#error');
  check('a password alone is refused in a tenant holding positions, and the page says why', (await state(analyst)) === 'signed-out' && refusal.includes('needs a second factor'), refusal);
  await analyst.screenshot({ path: `${OUT}/signin-mfa-refused.png` });

  // 5. A typed name is nobody when the server has no development identity.
  const typed = await tab('typed', '?user=pm');
  const typedErrors = errors.length;
  await typed.waitForFunction(() => window.__shared?.state() === 'refused', null, { timeout: 10_000 }).catch(() => {});
  check('?user=pm, a typed name, is refused by a server without --dev-identity', (await state(typed)) === 'refused' && (await typed.evaluate(() => window.__shared.nodes().length)) === 0);
  // That page's own refusals (403 on its session request) are expected; drop them.
  errors.splice(typedErrors);

  // 6. Logout ends it, here and at the other services. The token is read the
  // way a thief would have to: from the browser's cookie store, not the page.
  const stolen = (await pm.context().cookies()).find((c) => c.name === 'picasso_session')?.value;
  const atCollab = (token) => fetch(`http://127.0.0.1:${COLLAB_PORT}/v1/session`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);
  const before = stolen ? await atCollab(stolen) : 0;
  await pm.click('#logout');
  await pm.waitForFunction(() => window.__shared.state() === 'signed-out');
  await pm.reload();
  await pm.waitForFunction(() => window.__shared?.state() === 'signed-out');
  check('logout ends the session: a reload is signed out', (await pm.isVisible('#signin')));
  // The collaboration server re-reads picasso-auth's revocation list every 5 seconds.
  await new Promise((r) => setTimeout(r, 5_500));
  const after = stolen ? await atCollab(stolen) : 0;
  check('and the collaboration server refuses the logged-out session\'s unexpired token', before === 200 && after === 403, `${before} before logout, ${after} after`);

  check('no console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
} finally {
  for (const c of children) c.kill();
  await idp.close();
  try {
    execFileSync('psql', [PG, '-qc', `DROP SCHEMA ${SCHEMA} CASCADE`], { stdio: 'ignore' });
  } catch {
    // left to its owner; the schema is unique to this run
  }
}
process.exit(failures > 0 ? 1 : 0);
