/**
 * Drives the models page against the real Go gateway in a real browser.
 *
 * Builds services/gateway and runs it with providers that point at local
 * STAND-INS, written here: a Chat Completions server that answers every prompt
 * with "stand-in answer to: ...", and an OAuth provider whose authorize page
 * approves at once and whose key exchange checks the PKCE verifier, the way
 * OpenRouter documents its flow. No real provider is reached. What is checked
 * is everything between the user and the provider: signing in, pasting a key,
 * which key each call carries, that no key comes back to the page, that
 * positions never reach a vendor, and that the audit holds no content.
 *
 *   node apps/canvas-demo/scripts/models-shots.mjs [outDir]
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const PORT = Number(process.env.PORT ?? 8340);
const GW_PORT = Number(process.env.GW_PORT ?? 8751);
const MODEL_PORT = Number(process.env.MODEL_PORT ?? 8752);
const OAUTH_PORT = Number(process.env.OAUTH_PORT ?? 8753);
const SIGNED_IN_KEY = 'sk-standin-signed-in-key-4321';
const PASTED_KEY = 'sk-standin-pasted-key-8765';

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

const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => resolve(s));
});

// The stand-in model server: what each call carried, and a canned answer.
const modelCalls = [];
const modelServer = createServer(async (req, res) => {
  const body = JSON.parse((await readBody(req)) || '{}');
  modelCalls.push({ auth: req.headers.authorization ?? null, model: body.model, last: body.messages?.at(-1)?.content });
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    model: body.model, choices: [{ message: { content: `stand-in answer to: ${body.messages?.at(-1)?.content}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  }));
});

// The stand-in OAuth provider: approve at once, then exchange code + verifier.
const challenges = new Map();
let codes = 0;
const oauthServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${OAUTH_PORT}`);
  if (url.pathname === '/auth') {
    const code = `code-${(codes += 1)}`;
    challenges.set(code, url.searchParams.get('code_challenge'));
    const back = new URL(url.searchParams.get('callback_url'));
    back.searchParams.set('code', code);
    res.writeHead(302, { location: back.toString() }).end();
    return;
  }
  if (url.pathname === '/api/v1/auth/keys' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const expected = challenges.get(body.code);
    const actual = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
    challenges.delete(body.code);
    if (!expected || expected !== actual) {
      res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"bad verifier"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ key: SIGNED_IN_KEY }));
    return;
  }
  res.writeHead(404).end();
});

const work = await mkdtemp(join(tmpdir(), 'models-shots-'));
const providersFile = join(work, 'providers.json');
const model = `http://127.0.0.1:${MODEL_PORT}/v1`;
await writeFile(providersFile, JSON.stringify([
  { id: 'signin', name: 'SignIn stand-in (OAuth, vendor)', kind: 'openai', baseUrl: model, placement: 'vendor', auth: 'oauth',
    oauth: { authorizeUrl: `http://127.0.0.1:${OAUTH_PORT}/auth`, exchangeUrl: `http://127.0.0.1:${OAUTH_PORT}/api/v1/auth/keys` }, suggested: ['standin/open-model'] },
  { id: 'keyed', name: 'Keyed stand-in (API key, vendor)', kind: 'openai', baseUrl: model, placement: 'vendor', auth: 'api_key', suggested: ['standin/closed-model'] },
  { id: 'local', name: 'Local stand-in (self-hosted)', kind: 'openai', baseUrl: model, placement: 'self_hosted', auth: 'none', suggested: ['standin/open-weights'] },
]));
const binary = join(work, 'gateway');
execFileSync('go', ['build', '-o', binary, './cmd/gateway'], { cwd: join(ROOT, 'services/gateway'), stdio: 'inherit' });

const children = [];
try {
  await new Promise((r) => modelServer.listen(MODEL_PORT, '127.0.0.1', r));
  await new Promise((r) => oauthServer.listen(OAUTH_PORT, '127.0.0.1', r));
  const page_ = `http://localhost:${PORT}/apps/canvas-demo/models.html`;
  children.push(spawn(binary, ['-addr', `127.0.0.1:${GW_PORT}`, '-ephemeral', '-providers', providersFile, '-users', join(ROOT, 'services/dataplane/config/users.json'),
    '-public-url', `http://localhost:${PORT}/gw`, '-return-url', page_], { stdio: ['ignore', 'ignore', 'inherit'] }));
  children.push(spawn(process.execPath, ['scripts/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), GATEWAY_URL: `http://127.0.0.1:${GW_PORT}` }, stdio: 'ignore' }));
  await waitFor(`http://127.0.0.1:${GW_PORT}/healthz`);
  await waitFor(page_);

  await mkdir(OUT, { recursive: true });
  const executablePath = await resolveChromium();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage({ viewport: { width: 1000, height: 820 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/the server responded with a status of 4\d\d/.test(m.text()) && errors.push(m.text()));
  const bodies = [];
  page.on('response', async (r) => {
    if (r.url().includes('/gw/')) bodies.push(await r.text().catch(() => ''));
  });
  const ready = () => page.waitForFunction(() => window.__models?.ready());
  const state = (id) => page.locator(`.card[data-provider="${id}"] .state`).textContent();

  await page.goto(page_);
  await ready();
  check('three providers are listed, none connected but the shared one',
    (await page.evaluate(() => window.__models.providers().map((p) => `${p.id}:${p.connected}`).join(' '))) === 'signin:false keyed:false local:true');

  // 1. Sign in: the browser goes to the provider and comes back connected.
  await page.click('.card[data-provider="signin"] button[data-action="sign-in"]');
  await page.waitForURL(/models\.html/, { timeout: 10_000 });
  await ready();
  check('after the round trip the page says the provider is connected', (await page.locator('#banner').textContent()).includes('signin is connected'));
  check('the card says signed in, with the key\'s last four characters and nothing more', (await state('signin')) === 'signed in · …4321');
  check('the address bar no longer carries the sign-in result', !page.url().includes('connected='));

  // 2. A call on the signed-in account carries the key that sign-in produced.
  await page.selectOption('#provider', 'signin');
  await page.fill('#prompt', 'summarise the morning');
  await page.click('#send');
  await page.waitForFunction(() => window.__models.lastResult());
  check('a call through the signed-in provider answers', (await page.locator('#answer').textContent()).startsWith('stand-in answer to: summarise the morning'));
  check('and went out under the signed-in key', modelCalls.at(-1)?.auth === `Bearer ${SIGNED_IN_KEY}` && modelCalls.at(-1)?.model === 'standin/open-model');
  await page.screenshot({ path: `${OUT}/models-signed-in.png` });

  // 3. Paste a key; it goes in once and does not come back.
  await page.fill('.card[data-provider="keyed"] input[type=password]', PASTED_KEY);
  await page.click('.card[data-provider="keyed"] button[data-action="connect"]');
  await page.waitForFunction(() => window.__models.providers().find((p) => p.id === 'keyed')?.connected);
  check('a pasted key connects, shown by its last four characters', (await state('keyed')) === 'key connected · …8765');
  const html = await page.content();
  check('no key is anywhere in the page', !html.includes(PASTED_KEY) && !html.includes(SIGNED_IN_KEY));
  check('no gateway response carried a key back', bodies.length > 3 && bodies.every((b) => !b.includes(PASTED_KEY) && !b.includes(SIGNED_IN_KEY)), `${bodies.length} responses`);

  // 4. Positions: refused for the vendor before anything leaves; served locally.
  const before = modelCalls.length;
  await page.selectOption('#provider', 'keyed');
  await page.selectOption('#class', 'positions');
  await page.fill('#prompt', 'the book: long 10,000 NVDA');
  await page.click('#send');
  await page.waitForFunction(() => document.getElementById('error').textContent.length > 0);
  check('positions to a vendor are refused, with the reason', (await page.locator('#error').textContent()).includes('positions data may not go to Keyed stand-in'));
  check('and nothing reached the vendor', modelCalls.length === before);
  await page.selectOption('#provider', 'local');
  await page.click('#send');
  await page.waitForFunction(() => window.__models.lastResult()?.model === 'standin/open-weights');
  check('the same positions go to the self-hosted model, with no key', modelCalls.length === before + 1 && modelCalls.at(-1).auth === null);
  await page.screenshot({ path: `${OUT}/models-positions.png` });

  // 5. The audit lists the calls, and not what was said.
  const audit = await page.locator('#audit tbody').textContent();
  check('the audit lists the refusal and the calls', (await page.locator('#audit tbody tr').count()) === 3 && audit.includes('refused'));
  check('and holds no prompt text', !audit.includes('10,000 NVDA') && !audit.includes('summarise the morning'));

  // 6. Accounts are per user.
  await page.selectOption('#user', 'analyst');
  await page.waitForFunction(() => window.__models.providers().find((p) => p.id === 'signin')?.connected === false);
  check('the analyst has not signed in: the pm\'s account is the pm\'s', (await state('signin')) === 'not connected' && (await state('keyed')) === 'not connected');
  check('and sees none of the pm\'s calls', (await page.locator('#audit tbody tr').count()) === 0);

  // 7. Disconnect.
  await page.selectOption('#user', 'pm');
  await page.waitForFunction(() => window.__models.providers().find((p) => p.id === 'keyed')?.connected === true);
  await page.click('.card[data-provider="keyed"] button[data-action="disconnect"]');
  await page.waitForFunction(() => window.__models.providers().find((p) => p.id === 'keyed')?.connected === false);
  check('disconnecting says the key still has to be revoked with the provider', (await page.locator('#banner').textContent()).includes('Revoke the key'));

  if (errors.length > 0) check('no console errors', false, errors.join(' | '));
  else check('no console errors', true);
  await browser.close();
} finally {
  for (const c of children) c.kill();
  modelServer.close();
  oauthServer.close();
}
process.exit(failures > 0 ? 1 : 0);
