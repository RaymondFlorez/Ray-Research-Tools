/**
 * The cascade over real models: route, dispatch through services/gateway,
 * verify deterministically, escalate on failure.
 *
 * The task is doc.extract on positions data: read a position statement and
 * return each holding's market value and the stated total. The verifier is
 * this package's reconciliationVerifier, which accepts an answer only when its
 * parts sum to its total. The statements are SYNTHETIC, generated from a fixed
 * seed, so the true figures are known and every accepted answer can also be
 * checked against them, which the cascade itself never sees.
 *
 * The ladder is three open-weight models on the gateway's machine, smallest
 * first, then a vendor model the router may never use for positions. The
 * gateway's providers must be self_hosted for the three local models (the
 * dispatch refuses a placement that differs from the manifest's) and the
 * vendor must be configured, so the run shows the router declining it rather
 * than finding it missing.
 *
 *   GATEWAY_URL=http://127.0.0.1:8750 node packages/canvas-router/scripts/cascade-live.mjs [count]
 *
 * Providers it expects at the gateway, each an OpenAI-compatible server:
 *   local-360m -> smollm2-360m, local-1-7b -> smollm2-1.7b, local-1-5b -> qwen2.5-1.5b
 */

import { cascade, gatewayDispatch, GatewayClient, reconciliationVerifier } from '@picasso/canvas-router';

const BASE = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8750';
const COUNT = Number(process.argv[2] ?? 20);

const local = (id, paramsB, quality, cents) => ({
  id, version: '1', modalities: ['text'], tools: false, structuredOutput: false, vendor: 'open-weight', family: id.split('-')[0],
  paramsB, placement: 'self_hosted', centsPerKiloToken: cents, latencyMsP50: 1_000, latencyMsP95: 4_000,
  // An ordering by size, not a measurement: the eval harness would set these.
  quality: { 'doc.extract': quality }, deterministic: true, contextTokens: 8_192,
});
const POLICY = {
  version: 'cascade-live', updatedAt: '2026-11-20', lambdaCost: 1, lambdaLatency: 1,
  models: [
    local('smollm2-360m', 0.36, 0.5, 0.001),
    local('smollm2-1.7b', 1.7, 0.6, 0.004),
    local('qwen2.5-1.5b', 1.5, 0.7, 0.004),
    { ...local('frontier-a', undefined, 0.96, 1.5), vendor: 'vendor', family: 'frontier', placement: 'vendor' },
  ],
  entries: [{
    taskClass: 'doc.extract', slo: { kind: 'p95', ms: 30_000 },
    primary: ['smollm2-360m'], fallback: ['smollm2-1.7b', 'qwen2.5-1.5b', 'frontier-a'], escalateAfterFailures: 1,
  }],
};
const ROUTES = {
  'smollm2-360m': { provider: 'local-360m', model: 'smollm2-360m' },
  'smollm2-1.7b': { provider: 'local-1-7b', model: 'smollm2-1.7b' },
  'qwen2.5-1.5b': { provider: 'local-1-5b', model: 'qwen2.5-1.5b' },
  'frontier-a': { provider: 'openrouter', model: 'any' },
};

// SYNTHETIC position statements from a fixed seed.
let seed = 20261120;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'XOM', 'UNH', 'TSLA'];
function statement() {
  const n = 3 + Math.floor(rand() * 4);
  const names = [...TICKERS].sort(() => rand() - 0.5).slice(0, n);
  const parts = names.map(() => Math.round(50_000 + rand() * 4_950_000));
  const total = parts.reduce((a, b) => a + b, 0);
  const fmt = (x) => '$' + x.toLocaleString('en-US');
  const text = ['Position statement (synthetic), account 4471, as of 2026-11-19.',
    ...names.map((t, i) => `${t}: ${Math.round(parts[i] / (20 + rand() * 300))} shares, market value ${fmt(parts[i])}`),
    `Total market value: ${fmt(total)}`].join('\n');
  return { text, parts, total };
}

/** The model's text, read as {parts, total}; anything else is an answer that cannot verify. */
function parse(text) {
  const m = /\{[\s\S]*\}/.exec(text);
  try {
    const v = JSON.parse(m?.[0] ?? '');
    const num = (x) => (typeof x === 'number' ? x : Number(String(x).replace(/[$,\s]/g, '')));
    const parts = Array.isArray(v.parts) ? v.parts.map(num) : [];
    const total = num(v.total);
    if (parts.length === 0 || parts.some((p) => !Number.isFinite(p)) || !Number.isFinite(total)) return undefined;
    return { parts, total };
  } catch {
    return undefined;
  }
}
const reconcile = reconciliationVerifier(0);
const verify = (answer) => {
  const v = parse(answer.text);
  if (!v) return { accepted: false, confidence: 1, deterministic: true, reason: 'the answer is not {parts, total} JSON' };
  return reconcile(v);
};

const client = new GatewayClient({ baseUrl: BASE, user: 'pm' });
const providers = await client.providers();
const features = {
  taskClass: 'doc.extract', inputTokens: 200, expectedOutputTokens: 120, modalities: ['text'], toolsRequired: [], rigorFlag: false,
  dataSensitivity: 'positions', costCeilingCents: 100, latencyBudgetMs: 30_000, determinismRequired: false, priorFailures: [],
};

const rows = [];
for (let i = 0; i < COUNT; i += 1) {
  const s = statement();
  const prompt = {
    system: 'Extract the market value of each holding and the stated total market value. Reply with JSON only, in the form {"parts": [numbers], "total": number}, with no other text.',
    messages: [{ role: 'user', text: s.text }], maxTokens: 200, dataClass: 'positions', purpose: 'positions.extract',
  };
  const started = performance.now();
  const r = await cascade(POLICY, features, gatewayDispatch(client, ROUTES, providers, prompt), verify, { maxTiers: 4 });
  const ms = performance.now() - started;
  const final = parse(r.answer.text);
  const accepted = r.steps.at(-1).verdict.accepted;
  const right = final !== undefined && final.total === s.total && final.parts.length === s.parts.length && final.parts.every((p, k) => p === s.parts[k]);
  rows.push({ tiers: r.steps.map((st) => `${st.decision.model.id}:${st.verdict.accepted ? 'ok' : 'no'}`), accepted, right, ms, last: r.steps.at(-1).decision.model.id });
  console.log(`${String(i + 1).padStart(2)} ${accepted ? 'accepted' : 'unverified'} ${right ? 'right' : 'wrong'} ${(ms / 1000).toFixed(1)}s  ${rows.at(-1).tiers.join(' -> ')}`);
}

const by = (f) => rows.filter(f).length;
const tiersUsed = {};
for (const r of rows) for (const t of r.tiers) { const [id, ok] = t.split(':'); tiersUsed[id] ??= { tried: 0, accepted: 0 }; tiersUsed[id].tried += 1; if (ok === 'ok') tiersUsed[id].accepted += 1; }
const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log('\nper tier:', JSON.stringify(tiersUsed));
console.log(`accepted ${by((r) => r.accepted)}/${COUNT}; of those right ${by((r) => r.accepted && r.right)}; accepted but wrong ${by((r) => r.accepted && !r.right)}; unverified ${by((r) => !r.accepted)} (right anyway ${by((r) => !r.accepted && r.right)})`);
console.log(`ended at the first tier ${by((r) => r.tiers.length === 1 && r.accepted)}; the vendor tier was tried ${tiersUsed['frontier-a']?.tried ?? 0} times`);
console.log(`end to end p50 ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)}s, max ${(ms.at(-1) / 1000).toFixed(1)}s`);
const audit = await client.audit();
console.log(`gateway audit entries for pm: ${audit.length}, providers: ${[...new Set(audit.map((a) => a.provider))].join(', ')}`);
