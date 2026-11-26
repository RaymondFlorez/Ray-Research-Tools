/**
 * The QueryNode's front door over real models: a question, scoped, then
 * decomposed into a plan by a model through services/gateway, read by
 * `readPlan`, and shown as a `plan()` with its cost and approval.
 *
 * The cascade escalates when `readPlan` finds a fault, so the verifier is
 * deterministic: a plan is accepted when every step names a real kind, agent
 * and task class, and its dependencies exist and do not form a circle. That
 * is the shape of a runnable plan, not a judgment of a good one; the plans
 * the models wrote are printed so a person can judge that.
 *
 * Positions questions, so only the three local models may plan them. Calls
 * are pinned (temperature 0, seed 1): a rerun reproduces the run.
 *
 *   GATEWAY_URL=http://127.0.0.1:8750 node packages/canvas-agents/scripts/plan-live.mjs
 *
 * PLAN_TIERS=phi3-mini (comma-separated, cheapest first) plans with those models
 * only, so one model can be measured on its own; the default is the three-model
 * ladder. phi3-mini needs a provider local-phi3 at the gateway.
 */

import { cascade, DEFAULT_POLICY, gatewayDispatch, GatewayClient, route } from '@picasso/canvas-router';
import { AGENT_ROLES, plan, readPlan, scope, STEP_KINDS, TASK_CLASSES } from '@picasso/canvas-agents';
import { local, ROUTES } from '../../canvas-router/scripts/live-fixtures.mjs';

const BASE = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8750';
const withPlanning = (m, q) => ({ ...m, quality: { 'plan.decompose': q } });
const POLICY = {
  version: 'plan-live', updatedAt: '2026-11-24', lambdaCost: 1, lambdaLatency: 1,
  // An ordering by size, not a measurement.
  models: [
    withPlanning(local('smollm2-360m', 0.36, 0.5, 0.001), 0.5), withPlanning(local('smollm2-1.7b', 1.7, 0.6, 0.004), 0.6),
    withPlanning(local('qwen2.5-1.5b', 1.5, 0.7, 0.004), 0.7), withPlanning(local('phi3-mini', 3.8, 0.8, 0.008), 0.8),
  ],
  entries: [],
};
const TIERS = (process.env.PLAN_TIERS ?? 'smollm2-360m,smollm2-1.7b,qwen2.5-1.5b').split(',').map((t) => t.trim()).filter(Boolean);
for (const t of TIERS) if (!POLICY.models.some((m) => m.id === t)) throw new Error(`PLAN_TIERS names ${t}, which is not a model here`);
POLICY.models = POLICY.models.filter((m) => TIERS.includes(m.id));
POLICY.entries = [{ taskClass: 'plan.decompose', slo: { kind: 'p95', ms: 120_000 }, primary: [TIERS[0]], fallback: TIERS.slice(1), escalateAfterFailures: 1 }];

// The reference layer, as far as these questions need one.
const REFERENCE = {
  NVDA: [{ kind: 'instrument', id: 'eq:nvda:us', label: 'NVIDIA Corp' }],
  AAPL: [{ kind: 'instrument', id: 'eq:aapl:us', label: 'Apple Inc' }],
  TSLA: [{ kind: 'instrument', id: 'eq:tsla:us', label: 'Tesla Inc' }],
  'my portfolio': [{ kind: 'portfolio', id: 'pf:main', label: 'Main book' }],
  'the book': [{ kind: 'portfolio', id: 'pf:main', label: 'Main book' }],
};
const resolve = (mention) => REFERENCE[mention] ?? [];
const QUESTIONS = [
  'What happens to my portfolio if rates rise 50bp?',
  'How exposed is the book to NVDA earnings next week?',
  'Read the last AAPL call and tell me what management avoided saying.',
  'Which positions in my portfolio lost the most since Friday, and why?',
  'Stress the book for a 20% drop in TSLA and show the P&L.',
  'Compare NVDA and AAPL revenue growth over the last four quarters.',
  'Is my portfolio too concentrated in semiconductors?',
  'What would a parallel 100bp shift do to the bond sleeve of the book?',
  'Summarize what changed in NVDA guidance this quarter.',
  'Find the biggest risk in my portfolio this week.',
  'How did the book perform against the index last month?',
  'Should we trim TSLA given the delivery numbers?',
];

const SYSTEM = [
  'You plan research for a financial analyst. Break the question into steps and reply with JSON only:',
  '{"steps": [{"id": "...", "kind": "...", "agent": "...", "taskClass": "...", "description": "...", "dependsOn": ["..."]}]}',
  `kind is one of: ${STEP_KINDS.join(', ')}.`,
  `agent is one of: ${AGENT_ROLES.join(', ')}.`,
  `taskClass is required for reasoning steps and is one of: ${TASK_CLASSES.join(', ')}.`,
  'id is short, lower case. dependsOn lists the ids of earlier steps whose output this step needs.',
].join('\n');

/** Each step priced by the shipped router, never by the model. */
const estimate = ({ taskClass }) => {
  if (!taskClass) return { cents: 0.1, ms: 500 };
  try {
    const d = route(DEFAULT_POLICY, { taskClass, inputTokens: 2_000, expectedOutputTokens: 400, modalities: ['text'], toolsRequired: [], rigorFlag: false, dataSensitivity: 'positions', costCeilingCents: 100, latencyBudgetMs: 60_000, determinismRequired: false, priorFailures: [] });
    return { cents: d.estimatedCostCents, ms: d.model.latencyMsP50 };
  } catch {
    return { cents: 0, ms: 0 };
  }
};
const verify = (answer) => {
  const r = readPlan(answer.text, { estimate });
  return r.problems.length === 0
    ? { accepted: true, confidence: 1, deterministic: true, reason: `${r.steps.length} steps` }
    : { accepted: false, confidence: 1, deterministic: true, reason: r.problems.slice(0, 3).join('; ') };
};

const client = new GatewayClient({ baseUrl: BASE, user: 'pm' });
const providers = await client.providers();
const features = { taskClass: 'plan.decompose', inputTokens: 400, expectedOutputTokens: 400, modalities: ['text'], toolsRequired: [], rigorFlag: false, dataSensitivity: 'positions', costCeilingCents: 100, latencyBudgetMs: 120_000, determinismRequired: true, priorFailures: [] };

const tally = {};
const problems = {};
let accepted = 0;
const shown = [];
for (const question of QUESTIONS) {
  const scoped = scope({ question, resolve });
  const prompt = { system: SYSTEM, messages: [{ role: 'user', text: question }], maxTokens: 500, dataClass: 'positions', purpose: 'plan.decompose', pinned: { seed: 1 } };
  const started = performance.now();
  const r = await cascade(POLICY, features, gatewayDispatch(client, ROUTES, providers, prompt), verify, { maxTiers: TIERS.length });
  const ms = performance.now() - started;
  for (const st of r.steps) {
    const id = st.decision.model.id;
    tally[id] ??= { tried: 0, accepted: 0 };
    tally[id].tried += 1;
    if (st.verdict.accepted) tally[id].accepted += 1;
    if (!st.verdict.accepted) for (const p of st.verdict.reason.split('; ')) {
      const kind = p.replace(/^step \d+ \([^)]*\): |^step \d+: /, '').replace(/"[^"]*"/g, '"…"').replace(/^\S+ depends on/, '… depends on').replace(/the steps .* depend/, 'the steps … depend');
      problems[kind] = (problems[kind] ?? 0) + 1;
    }
  }
  const last = r.steps.at(-1);
  const ok = last.verdict.accepted;
  if (ok) {
    accepted += 1;
    const read = readPlan(last.answer.text, { estimate });
    const p = plan({ scope: scoped, steps: read.steps });
    if (shown.length < 3) shown.push({ question, by: last.decision.model.id, steps: p.steps.map((s) => `${s.id}[${s.kind}/${s.agent}${s.taskClass ? `/${s.taskClass}` : ''}]<-${s.dependsOn.join(',') || '-'}`), cents: p.totalCents, approval: p.needsApproval });
  }
  console.log(`${ok ? 'plan    ' : 'no plan '} ${(ms / 1000).toFixed(1)}s  ${r.steps.map((s) => `${s.decision.model.id}:${s.verdict.accepted ? 'ok' : 'no'}`).join(' -> ')}  ${question}`);
}
console.log('\nper model:', JSON.stringify(tally));
console.log(`runnable plans: ${accepted} of ${QUESTIONS.length}`);
console.log('faults found, by kind:');
for (const [k, n] of Object.entries(problems).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${n}  ${k}`);
for (const s of shown) console.log(`\n${s.question}\n  by ${s.by}, ${s.cents.toFixed(2)}c, approval ${s.approval ? 'needed' : 'not needed'}\n  ${s.steps.join('\n  ')}`);
