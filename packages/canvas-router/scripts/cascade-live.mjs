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

import { createHash } from 'node:crypto';
import { cascade, gatewayDispatch, GatewayClient } from '@picasso/canvas-router';
import { exact, parse, POLICY as LADDER, PROMPT, ROUTES, statements, verify } from './live-fixtures.mjs';

const BASE = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8750';
const COUNT = Number(process.argv[2] ?? 20);
// A policy the eval harness rewrote, as JSON, in place of the shipped ordering by size.
const POLICY = process.env.POLICY_FILE ? JSON.parse((await import('node:fs')).readFileSync(process.env.POLICY_FILE, 'utf8')) : LADDER;
const statement = statements(20261120);
// PINNED=<seed>: every call at temperature 0 with that seed, and the request marked as one that must reproduce.
const PINNED = process.env.PINNED ? { seed: Number(process.env.PINNED) } : undefined;

const client = new GatewayClient({ baseUrl: BASE, user: 'pm' });
const providers = await client.providers();
const features = {
  taskClass: 'doc.extract', inputTokens: 200, expectedOutputTokens: 120, modalities: ['text'], toolsRequired: [], rigorFlag: false,
  dataSensitivity: 'positions', costCeilingCents: 100, latencyBudgetMs: 30_000, determinismRequired: PINNED !== undefined, priorFailures: [],
};

const rows = [];
for (let i = 0; i < COUNT; i += 1) {
  const s = statement();
  const prompt = {
    system: PROMPT,
    messages: [{ role: 'user', text: s.text }], maxTokens: 200, dataClass: 'positions', purpose: 'positions.extract', ...(PINNED ? { pinned: PINNED } : {}),
  };
  const started = performance.now();
  const r = await cascade(POLICY, features, gatewayDispatch(client, ROUTES, providers, prompt), verify, { maxTiers: 4 });
  const ms = performance.now() - started;
  const final = parse(r.answer.text);
  const accepted = r.steps.at(-1).verdict.accepted;
  const right = exact(final, s);
  rows.push({ tiers: r.steps.map((st) => `${st.decision.model.id}:${st.verdict.accepted ? 'ok' : 'no'}`), accepted, right, ms, last: r.steps.at(-1).decision.model.id });
  const answer = createHash('sha256').update(r.steps.map((st) => st.answer.text).join('\u0000')).digest('hex').slice(0, 12);
  console.log(`${String(i + 1).padStart(2)} ${accepted ? 'accepted' : 'unverified'} ${right ? 'right' : 'wrong'} ${(ms / 1000).toFixed(1)}s  ${rows.at(-1).tiers.join(' -> ')}  answers ${answer}`);
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
