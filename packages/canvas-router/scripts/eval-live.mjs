/**
 * The eval harness over real models: score each local model on a golden set
 * through services/gateway, and rewrite the routing policy from the scores.
 *
 * The golden set is 40 SYNTHETIC position statements from a seed other than
 * the cascade's, so the policy is not scored on the requests it will then
 * route. An item scores 1 when the model's extraction is exactly the
 * statement's figures, 0 otherwise. Writes the rewritten policy as JSON for
 * `cascade-live.mjs` (POLICY_FILE) and prints what changed.
 *
 *   GATEWAY_URL=http://127.0.0.1:8750 node packages/canvas-router/scripts/eval-live.mjs out.json [items]
 */

import { writeFileSync } from 'node:fs';
import { GatewayClient, rewrite, runEval } from '@picasso/canvas-router';
import { exact, parse, POLICY, PROMPT, ROUTES, statements } from './live-fixtures.mjs';

const BASE = process.env.GATEWAY_URL ?? 'http://127.0.0.1:8750';
const [OUT, N = '40'] = process.argv.slice(2);
if (!OUT) throw new Error('usage: eval-live.mjs out.json [items]');

const golden = statements(4_000_001);
const set = {
  taskClass: 'doc.extract',
  version: `synthetic-statements-${N}`,
  items: Array.from({ length: Number(N) }, (_, i) => {
    const s = golden();
    return { id: `stmt-${i}`, input: s.text, expected: s };
  }),
  score: (answer, item) => (exact(answer, item.expected) ? 1 : 0),
};

const client = new GatewayClient({ baseUrl: BASE, user: 'pm' });
const local = POLICY.models.filter((m) => m.placement !== 'vendor');
const run = await runEval(local, [set], async (model, item) => {
  const route = ROUTES[model.id];
  const r = await client.chat({ provider: route.provider, model: route.model, system: PROMPT, messages: [{ role: 'user', text: item.input }], maxTokens: 200, dataClass: 'positions', purpose: 'eval.doc_extract' });
  return parse(r.text);
});

for (const s of run.scores) console.log(`${s.modelId}: ${s.quality.toFixed(3)} ± ${s.standardError.toFixed(3)} over ${s.items} items${s.caveat ? ` (${s.caveat})` : ''}`);
const rewritten = rewrite(POLICY, { ...run, at: new Date().toISOString() });
for (const c of rewritten.changes) console.log(`  ${c.modelId}: ${c.from} -> ${c.to.toFixed(3)}`);
for (const s of rewritten.skipped) console.log(`  skipped ${s.modelId}: ${s.reason}`);
writeFileSync(OUT, JSON.stringify(rewritten.policy, null, 1));
console.log(`policy ${rewritten.policy.version} written to ${OUT}`);
