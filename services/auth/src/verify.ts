/**
 * What a service does with a session token: verify it against picasso-auth's
 * published key, and decide.
 *
 * The data plane and the gateway do the same in Go (`identity` in each
 * module), and the verdicts must agree. `test/tokens.test.ts` writes
 * `testdata/tokens.json` — tokens a fixed key signed, the moment each is
 * presented, and the verdict — and the Go tests read it. Change a rule here
 * and the Go suites say so.
 *
 * Logout reaches a service through the revocation list picasso-auth
 * publishes at /auth/revoked. A service passes what it knows of that list to
 * every verification, and `'unknown'` when its copy is too old to trust: a
 * service that cannot tell whether a session was logged out refuses it,
 * rather than serving whoever held the token.
 */

import { SESSION_TTL_MS } from '@picasso/canvas-guard';
import { jwtVerify, type JWTVerifyGetKey, type CryptoKey } from 'jose';
import { errors } from 'jose';
import { AUDIENCE } from './sessions.js';

export type Refusal =
  | 'unsupported_alg'
  | 'invalid_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'lifetime_too_long'
  | 'revoked'
  | 'revocation_unknown'
  | 'malformed';

export interface Verified {
  user: string;
  tenant: string;
  sid: string;
  exp: number;
}

export type Verdict = { ok: true; session: Verified } | { ok: false; reason: Refusal; message: string };

/** Seconds of clock skew tolerated, both ways. */
export const LEEWAY_S = 30;

export async function verifySessionToken(
  token: string,
  key: JWTVerifyGetKey | CryptoKey,
  options: {
    issuer: string;
    /** Sessions logged out, from picasso-auth's list; `'unknown'` when that list is not current. */
    revoked: ReadonlySet<string> | 'unknown';
    now?: number;
  },
): Promise<Verdict> {
  const now = options.now ?? Date.now();
  const refuse = (reason: Refusal, message: string): Verdict => ({ ok: false, reason, message });
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key as JWTVerifyGetKey, {
      issuer: options.issuer, audience: AUDIENCE, algorithms: ['EdDSA'], clockTolerance: LEEWAY_S, currentDate: new Date(now),
    }));
  } catch (err) {
    const m = (err as Error).message;
    if (err instanceof errors.JOSEAlgNotAllowed || err instanceof errors.JOSENotSupported) return refuse('unsupported_alg', m);
    if (err instanceof errors.JWSSignatureVerificationFailed || err instanceof errors.JWKSNoMatchingKey) return refuse('invalid_signature', m);
    if (err instanceof errors.JWTExpired) return refuse('expired', m);
    if (err instanceof errors.JWTClaimValidationFailed) {
      if (err.claim === 'iss') return refuse('wrong_issuer', m);
      if (err.claim === 'aud') return refuse('wrong_audience', m);
      if (err.claim === 'nbf' || err.claim === 'iat') return refuse('not_yet_valid', m);
    }
    return refuse('malformed', m);
  }
  const iat = (payload.iat ?? 0) * 1000;
  const exp = (payload.exp ?? 0) * 1000;
  if (!payload.iat || !payload.exp || typeof payload.sub !== 'string' || typeof payload.tenant !== 'string' || typeof payload.sid !== 'string') {
    return refuse('malformed', 'a session token names its subject, tenant, session, and when it was issued and expires');
  }
  if (iat > now + LEEWAY_S * 1000) return refuse('not_yet_valid', 'the token was issued in the future');
  if (exp - iat > SESSION_TTL_MS) return refuse('lifetime_too_long', `the token lives ${Math.round((exp - iat) / 60_000)} minutes against a limit of 15`);
  if (options.revoked === 'unknown') return refuse('revocation_unknown', 'this service cannot reach picasso-auth\'s list of logged-out sessions');
  if (options.revoked.has(payload.sid)) return refuse('revoked', 'this session was logged out');
  return { ok: true, session: { user: payload.sub, tenant: payload.tenant, sid: payload.sid, exp } };
}

/** How often a service re-reads the list, and how old its copy may get before it refuses every token. */
export const REVOCATION_REFRESH_MS = 5_000;
export const REVOCATION_MAX_STALE_MS = 30_000;

/**
 * A service's copy of picasso-auth's revocation list, re-read at most every
 * `refreshMs` when asked, and `'unknown'` once no read has succeeded for
 * `maxStaleMs`. So a logout reaches the service within `refreshMs` while
 * picasso-auth answers, and an outage longer than `maxStaleMs` stops the
 * service accepting sessions at all.
 */
export class RevocationList {
  private sids: ReadonlySet<string> = new Set();
  private fetchedAt: number | undefined;
  private attemptedAt = -Infinity;
  private inflight: Promise<void> | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly refreshMs: number;
  private readonly maxStaleMs: number;

  constructor(
    private readonly url: string,
    options: { fetch?: typeof fetch; now?: () => number; refreshMs?: number; maxStaleMs?: number } = {},
  ) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? REVOCATION_REFRESH_MS;
    this.maxStaleMs = options.maxStaleMs ?? REVOCATION_MAX_STALE_MS;
  }

  async current(): Promise<ReadonlySet<string> | 'unknown'> {
    if (this.now() - this.attemptedAt >= this.refreshMs) {
      this.inflight ??= this.read().finally(() => {
        this.inflight = undefined;
      });
    }
    if (this.inflight) await this.inflight;
    if (this.fetchedAt === undefined || this.now() - this.fetchedAt > this.maxStaleMs) return 'unknown';
    return this.sids;
  }

  private async read(): Promise<void> {
    this.attemptedAt = this.now();
    try {
      const res = await this.fetcher(this.url, { signal: AbortSignal.timeout(2_000) });
      const body = (await res.json()) as { sids?: unknown };
      if (!res.ok || !Array.isArray(body.sids)) return;
      this.sids = new Set(body.sids.map(String));
      this.fetchedAt = this.now();
    } catch {
      // Kept as it was: the copy ages, and goes unknown past maxStaleMs.
    }
  }
}
