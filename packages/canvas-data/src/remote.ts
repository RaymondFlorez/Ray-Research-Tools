/**
 * Point-in-time reads over the data plane (PRD 2.3, 3.8).
 *
 * `BitemporalStore` answers in-process; `services/dataplane` answers the same
 * questions over HTTP from Postgres, under the caller's entitlements. This is
 * the client, and the one thing it adds to an HTTP call is the rule the time
 * scrub depends on: **every read names its knowledge time.** `read` takes the
 * canvas's time — pinned to a morning, or live — and turns it into one through
 * `knowledgeTimeFor`, so a scrubbed canvas cannot quietly read today.
 *
 * What comes back keeps the server's distinction between a value and a
 * withheld value: a fact the caller may not see is in `blocked`, with the
 * reason, and never replaced by an older version they happen to be allowed.
 */

import type { AsOfQuery, Instant } from './bitemporal.js';
import { knowledgeTimeFor, type CanvasTime } from './timescrub.js';

export interface RemoteObservation {
  validTime: Instant;
  value: number;
  knownAt: Instant;
  source?: string;
  dataClass: string;
  vendor?: string;
}

export interface RemoteRead {
  observations: RemoteObservation[];
  blocked: Array<{ validTime: Instant; decision: { allowed: false; reason: string; message: string } }>;
}

export interface RemoteVersion {
  knowledgeTime: Instant;
  value?: number;
  restatement?: boolean;
  source?: string;
  blocked?: { reason: string; message: string };
}

export interface RemoteVersions {
  versions: Array<{ validTime: Instant; knowledgeTime: Instant; value: number; restatement?: boolean; source?: string }>;
  withheld: Array<{ validTime: Instant; knowledgeTime: Instant; decision: { allowed: false; reason: string; message: string } }>;
}

/** A fact as the data plane stores it: classified, always. */
export interface RemoteFact {
  key: string;
  validTime: Instant;
  knowledgeTime: Instant;
  value: number;
  source?: string;
  restatement?: boolean;
  dataClass: 'public' | 'licensed' | 'positions' | 'mnpi_risk';
  vendor?: string;
}

/** The most keys one batched read may name: `server.MaxBatchKeys` in the data plane. */
export const MAX_BATCH_KEYS = 5000;

export class DataPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`data plane ${status}: ${message}`);
    this.name = 'DataPlaneError';
  }
}

export interface RemoteOptions {
  /** Where the data plane is, e.g. `http://127.0.0.1:8740` or `/` behind a proxy. */
  baseUrl: string;
  /** The caller, as the data plane knows it. A development stand-in for OIDC. */
  user: string;
  /**
   * Why this client reads, for PRD 7.2's audit trail, e.g. `canvas.render`.
   * A read that returns position or MNPI-risk data is refused without one,
   * and recorded with it before it is served.
   */
  purpose?: string;
  fetch?: typeof fetch;
}

export class RemotePointInTime {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: RemoteOptions) {
    this.base = options.baseUrl.replace(/\/$/, '');
    this.fetcher = options.fetch ?? fetch;
  }

  /** As of an explicit knowledge time. */
  async asOf(query: AsOfQuery): Promise<RemoteRead> {
    const params = new URLSearchParams({ key: query.key, knowledge: query.knowledgeTime });
    if (query.from !== undefined) params.set('from', query.from);
    if (query.to !== undefined) params.set('to', query.to);
    return this.get<RemoteRead>(`/v1/asof?${params}`);
  }

  /**
   * Many keys at one knowledge time: `POST /v1/asof/batch`, each key's answer
   * exactly the single read's. Split into requests of at most
   * `MAX_BATCH_KEYS`, the data plane's limit.
   */
  async asOfMany(keys: readonly string[], knowledgeTime: Instant): Promise<Map<string, RemoteRead>> {
    const distinct = [...new Set(keys)];
    const out = new Map<string, RemoteRead>();
    for (let i = 0; i < distinct.length; i += MAX_BATCH_KEYS) {
      const chunk = distinct.slice(i, i + MAX_BATCH_KEYS);
      const res = await this.fetcher(`${this.base}/v1/asof/batch`, {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ knowledge: knowledgeTime, keys: chunk }),
      });
      const body = (await res.json()) as { results?: Record<string, RemoteRead>; error?: string };
      if (!res.ok || !body.results) throw new DataPlaneError(res.status, body.error ?? 'batch refused');
      for (const key of chunk) {
        const r = body.results[key];
        if (!r) throw new DataPlaneError(res.status, `the batch answered without ${key}`);
        out.set(key, r);
      }
    }
    return out;
  }

  /**
   * What a node on a canvas at `time` reads: as of the pin when the canvas is
   * scrubbed, as of now when it is live.
   */
  read(key: string, time: CanvasTime, now: () => Instant, range: { from?: Instant; to?: Instant } = {}): Promise<RemoteRead> {
    return this.asOf({ key, knowledgeTime: knowledgeTimeFor(time, now), ...range });
  }

  /** Every version of one fact, oldest first, withheld ones marked. */
  async history(key: string, validTime: Instant): Promise<RemoteVersion[]> {
    const params = new URLSearchParams({ key, valid: validTime });
    return (await this.get<{ versions: RemoteVersion[] }>(`/v1/history?${params}`)).versions;
  }

  /**
   * Every version in a valid-time range, as a backtest loads it, with the
   * versions this caller may not see listed in `withheld` rather than dropped.
   */
  async versions(key: string, range: { from?: Instant; to?: Instant } = {}): Promise<RemoteVersions> {
    const params = new URLSearchParams({ key });
    if (range.from !== undefined) params.set('from', range.from);
    if (range.to !== undefined) params.set('to', range.to);
    return this.get<RemoteVersions>(`/v1/versions?${params}`);
  }

  /** Appends facts. The data plane refuses this unless the caller is a writer. */
  async append(facts: readonly RemoteFact[]): Promise<number> {
    const res = await this.fetcher(`${this.base}/v1/facts`, {
      method: 'POST',
      headers: { 'X-Picasso-User': this.options.user, 'content-type': 'application/json' },
      body: JSON.stringify(facts),
    });
    const body = (await res.json()) as { appended?: number; error?: string };
    if (!res.ok) throw new DataPlaneError(res.status, body.error ?? 'append refused');
    return body.appended ?? 0;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'X-Picasso-User': this.options.user };
    if (this.options.purpose) headers['X-Picasso-Purpose'] = this.options.purpose;
    return headers;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetcher(`${this.base}${path}`, { headers: this.headers() });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new DataPlaneError(res.status, body.error ?? 'request refused');
    return body;
  }
}
