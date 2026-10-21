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

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetcher(`${this.base}${path}`, { headers: { 'X-Picasso-User': this.options.user } });
    const body = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new DataPlaneError(res.status, body.error ?? 'request refused');
    return body;
  }
}
