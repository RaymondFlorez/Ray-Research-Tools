import { describe, expect, it } from 'vitest';
import { cascade, sqlVerifier } from '../src/cascade.js';
import { GatewayClient, GatewayError, PlacementMismatch, gatewayDispatch, type GatewayProvider } from '../src/gateway.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import type { RoutingFeatures } from '../src/router.js';

/** Records what was asked and answers like the gateway would, per path. */
function gatewayStandIn(answer: (path: string, body: any) => { status?: number; body: unknown }) {
  const calls: Array<{ method: string; url: string; user: string | null; body: any }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const u = new URL(String(url));
    calls.push({ method: init?.method ?? 'GET', url: u.pathname, user: new Headers(init?.headers).get('X-Picasso-User'), body });
    const a = answer(u.pathname, body);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetcher };
}

const providers: GatewayProvider[] = [
  { id: 'vllm', name: 'vLLM', kind: 'openai', placement: 'self_hosted', auth: 'none', accepts: ['public', 'licensed', 'positions', 'mnpi_risk'], connected: true },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', placement: 'vendor', auth: 'api_key', accepts: ['public', 'licensed'], connected: true },
];

const routes = {
  'local-3b': { provider: 'vllm', model: 'llama-3.2-3b' },
  'server-8b': { provider: 'vllm', model: 'llama-3.1-8b' },
  'qwen-coder-32b': { provider: 'vllm', model: 'Qwen/Qwen2.5-Coder-32B-Instruct' },
  'open-70b': { provider: 'vllm', model: 'llama-3.3-70b' },
  'frontier-a': { provider: 'anthropic', model: 'claude-opus-5-5' },
  'frontier-b': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
};

const features: RoutingFeatures = {
  taskClass: 'sql.generate', inputTokens: 2_000, expectedOutputTokens: 300, modalities: ['text'], toolsRequired: [],
  rigorFlag: false, dataSensitivity: 'public', costCeilingCents: 50, latencyBudgetMs: 800, determinismRequired: false, priorFailures: [],
};

const prompt = { messages: [{ role: 'user' as const, text: 'revenue by quarter for NVDA' }], maxTokens: 256, dataClass: 'public' as const };
const verify = sqlVerifier(new Set(['fundamentals']), new Set(['symbol', 'revenue', 'quarter']));

describe('GatewayClient', () => {
  it('names the caller on every request and never sends a key anywhere but the connect call', async () => {
    const { calls, fetcher } = gatewayStandIn((path) => ({ body: path === '/v1/providers' ? { providers } : path.endsWith('/oauth') ? { authorizeUrl: 'https://openrouter.ai/auth?x' } : { provider: 'anthropic', method: 'api_key', hint: '…abcd' } }));
    const client = new GatewayClient({ baseUrl: 'http://gw/', user: 'pm', fetch: fetcher });
    expect((await client.providers()).map((p) => p.id)).toEqual(['vllm', 'anthropic']);
    expect(await client.connectKey('anthropic', 'sk-ant-xyz-abcd')).toMatchObject({ hint: '…abcd' });
    expect(await client.signIn('openrouter')).toBe('https://openrouter.ai/auth?x');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/providers', 'PUT /v1/accounts/anthropic', 'POST /v1/accounts/openrouter/oauth']);
    expect(calls.every((c) => c.user === 'pm')).toBe(true);
    expect(calls[1]!.body).toEqual({ apiKey: 'sk-ant-xyz-abcd' });
  });

  it('surfaces a refusal with the gateway\'s reason', async () => {
    const { fetcher } = gatewayStandIn(() => ({ status: 403, body: { error: 'positions data may not go to Anthropic, a vendor\'s API' } }));
    const client = new GatewayClient({ baseUrl: 'http://gw', user: 'pm', fetch: fetcher });
    await expect(client.chat({ provider: 'anthropic', model: 'claude-opus-5-5', ...prompt, dataClass: 'positions' })).rejects.toThrow(GatewayError);
  });
});

describe('a cascade dispatched through the gateway', () => {
  it('sends the routed model under its provider\'s name, and stops when the SQL verifies', async () => {
    const { calls, fetcher } = gatewayStandIn(() => ({
      body: { provider: 'vllm', response: { text: "select revenue from fundamentals where symbol = 'NVDA'", stop: 'end', model: 'Qwen/Qwen2.5-Coder-32B-Instruct', inputTokens: 40, outputTokens: 12 } },
    }));
    const client = new GatewayClient({ baseUrl: 'http://gw', user: 'pm', fetch: fetcher });
    const result = await cascade(DEFAULT_POLICY, features, gatewayDispatch(client, routes, providers, prompt), (a, m) => verify(a.text, m));
    expect(result.terminatedAtCheapTier).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ provider: 'vllm', model: 'Qwen/Qwen2.5-Coder-32B-Instruct', dataClass: 'public' });
  });

  it('refuses a model whose manifest placement is not the gateway provider\'s', async () => {
    const { calls, fetcher } = gatewayStandIn(() => ({ body: {} }));
    const client = new GatewayClient({ baseUrl: 'http://gw', user: 'pm', fetch: fetcher });
    // The manifest says the coder is self-hosted; route it to a vendor anyway.
    const wrong = { ...routes, 'qwen-coder-32b': { provider: 'anthropic', model: 'claude-haiku-5-5' } };
    await expect(cascade(DEFAULT_POLICY, features, gatewayDispatch(client, wrong, providers, prompt), (a, m) => verify(a.text, m)))
      .rejects.toThrow(PlacementMismatch);
    expect(calls).toHaveLength(0);
  });
});
