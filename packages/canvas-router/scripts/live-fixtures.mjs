/**
 * What the live scripts share: the local ladder, its gateway routes, and the
 * SYNTHETIC position statements, generated from a seed so the truth is known.
 */

import { reconciliationVerifier } from '@picasso/canvas-router';

export const local = (id, paramsB, quality, cents) => ({
  id, version: '1', modalities: ['text'], tools: false, structuredOutput: false, vendor: 'open-weight', family: id.split('-')[0],
  paramsB, placement: 'self_hosted', centsPerKiloToken: cents, latencyMsP50: 1_000, latencyMsP95: 4_000,
  // An ordering by size, not a measurement: the eval harness would set these.
  quality: { 'doc.extract': quality }, deterministic: true, contextTokens: 8_192,
});
export const POLICY = {
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
export const ROUTES = {
  'smollm2-360m': { provider: 'local-360m', model: 'smollm2-360m' },
  'smollm2-1.7b': { provider: 'local-1-7b', model: 'smollm2-1.7b' },
  'qwen2.5-1.5b': { provider: 'local-1-5b', model: 'qwen2.5-1.5b' },
  'phi3-mini': { provider: 'local-phi3', model: 'phi3-mini' },
  'frontier-a': { provider: 'openrouter', model: 'any' },
};

/** SYNTHETIC position statements from a seed: the same seed, the same statements. */
export function statements(seed) {
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  return () => statement(rand);
}
const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'XOM', 'UNH', 'TSLA'];
function statement(rand) {
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
export function parse(text) {
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
export const verify = (answer) => {
  const v = parse(answer.text);
  if (!v) return { accepted: false, confidence: 1, deterministic: true, reason: 'the answer is not {parts, total} JSON' };
  return reconcile(v);
};


export const PROMPT = 'Extract the market value of each holding and the stated total market value. Reply with JSON only, in the form {"parts": [numbers], "total": number}, with no other text.';

/** Whether an answer is exactly the statement's figures. */
export const exact = (v, s) => v !== undefined && v.total === s.total && v.parts.length === s.parts.length && v.parts.every((p, k) => p === s.parts[k]);
