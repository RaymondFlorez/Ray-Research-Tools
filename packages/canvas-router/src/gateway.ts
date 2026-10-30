/**
 * Dispatch through the model gateway (`services/gateway`).
 *
 * This package routes and dispatches nothing itself; `cascade` takes a
 * `Dispatch` from its caller. `gatewayDispatch` is that function for real
 * models: each model id in the routing policy maps to a provider the gateway
 * has configured and the provider's own name for the model, and the call goes
 * out on the user's own account with that provider.
 *
 * One check is made before anything is sent, because it is the one the two
 * sides could disagree on silently: **a model's placement in the router's
 * manifest must be the gateway provider's placement.** The router's hard rule
 * decides from the manifest which models may see positions. If a manifest
 * called a model self-hosted that the gateway reaches through a vendor's API,
 * the router would choose it for positions, and only the gateway's own rule
 * would stand between the book and the vendor; the other way round, the router
 * would never use a model it could. Either way the two descriptions of one
 * model differ, and the dispatch is refused rather than run on either.
 */

import type { Dispatch } from './cascade.js';
import type { Model, Placement } from './policy.js';

export type DataClass = 'public' | 'licensed' | 'positions' | 'mnpi_risk';

export interface GatewayProvider {
  id: string;
  name: string;
  kind: 'anthropic' | 'openai' | 'gemini';
  placement: Placement;
  /** How a user connects it: signing in, an API key, or nothing (a shared self-hosted server). */
  auth: 'oauth' | 'api_key' | 'none';
  /** The data classes this provider may receive. */
  accepts: DataClass[];
  models?: string[];
  suggested?: string[];
  connected: boolean;
  account?: { method: 'oauth' | 'api_key'; hint: string; connectedAt: string };
}

export interface GatewayMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface GatewayChat {
  provider: string;
  model: string;
  system?: string;
  messages: GatewayMessage[];
  maxTokens: number;
  dataClass: DataClass;
  /**
   * Why the call is made, for PRD 7.2's audit trail: a task name such as
   * `sql.generate`. The gateway refuses a dispatch without one.
   */
  purpose: string;
}

export interface GatewayResponse {
  text: string;
  /** `refusal`: the provider declined; the text, if any, is not an answer. */
  stop: 'end' | 'max_tokens' | 'refusal' | 'other';
  stopDetail?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface GatewayAuditEntry {
  at: string;
  provider: string;
  model: string;
  dataClass: DataClass;
  outcome: string;
  inputTokens?: number;
  outputTokens?: number;
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`gateway ${status}: ${message}`);
    this.name = 'GatewayError';
  }
}

export interface GatewayOptions {
  /** Where the gateway is, e.g. `http://127.0.0.1:8750` or `/gw` behind a proxy. */
  baseUrl: string;
  /** The caller, as the gateway knows it. A development stand-in for OIDC. */
  user: string;
  fetch?: typeof fetch;
}

export class GatewayClient {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: GatewayOptions) {
    this.base = options.baseUrl.replace(/\/$/, '');
    this.fetcher = options.fetch ?? ((...args) => fetch(...args));
  }

  async providers(): Promise<GatewayProvider[]> {
    return (await this.call<{ providers: GatewayProvider[] }>('GET', '/v1/providers')).providers;
  }

  /** Stores the user's API key for a provider. The key does not come back. */
  async connectKey(provider: string, apiKey: string): Promise<GatewayProvider['account']> {
    return this.call('PUT', `/v1/accounts/${encodeURIComponent(provider)}`, { apiKey });
  }

  async disconnect(provider: string): Promise<void> {
    await this.call('DELETE', `/v1/accounts/${encodeURIComponent(provider)}`);
  }

  /** Starts a sign-in; the browser goes to the URL returned. */
  async signIn(provider: string): Promise<string> {
    return (await this.call<{ authorizeUrl: string }>('POST', `/v1/accounts/${encodeURIComponent(provider)}/oauth`)).authorizeUrl;
  }

  async chat(request: GatewayChat): Promise<GatewayResponse> {
    return (await this.call<{ response: GatewayResponse }>('POST', '/v1/chat', request)).response;
  }

  async audit(): Promise<GatewayAuditEntry[]> {
    return (await this.call<{ entries: GatewayAuditEntry[] }>('GET', '/v1/audit')).entries;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: { 'X-Picasso-User': this.options.user, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new GatewayError(res.status, parsed.error ?? 'request refused');
    return parsed;
  }
}

/** Where a routing-policy model id goes: a gateway provider and that provider's name for it. */
export interface GatewayRoute {
  provider: string;
  model: string;
}

export class PlacementMismatch extends Error {
  constructor(
    readonly modelId: string,
    readonly manifest: Placement,
    readonly gateway: Placement,
    readonly provider: string,
  ) {
    super(
      `${modelId} is ${manifest} in the routing manifest but ${gateway} at the gateway (${provider}); ` +
        'the router would decide what it may see from a placement the call does not have',
    );
    this.name = 'PlacementMismatch';
  }
}

export interface GatewayPrompt {
  system?: string;
  messages: GatewayMessage[];
  maxTokens: number;
  dataClass: DataClass;
  /**
   * Why the call is made, for PRD 7.2's audit trail: a task name such as
   * `sql.generate`. The gateway refuses a dispatch without one.
   */
  purpose: string;
}

/**
 * A `Dispatch` for `cascade` that calls each model through the gateway.
 *
 * `providers` is the gateway's own listing, read once by the caller, so the
 * placement check runs against what the gateway will actually do.
 */
export function gatewayDispatch(
  client: GatewayClient,
  routes: Readonly<Record<string, GatewayRoute>>,
  providers: readonly GatewayProvider[],
  prompt: GatewayPrompt,
): Dispatch<GatewayResponse> {
  const byId = new Map(providers.map((p) => [p.id, p]));
  return async (model: Model) => {
    const route = routes[model.id];
    if (!route) throw new Error(`no gateway route for ${model.id}`);
    const provider = byId.get(route.provider);
    if (!provider) throw new Error(`${model.id} routes to ${route.provider}, which the gateway does not have`);
    if (provider.placement !== model.placement) throw new PlacementMismatch(model.id, model.placement, provider.placement, provider.id);
    return client.chat({ provider: provider.id, model: route.model, ...prompt });
  };
}
