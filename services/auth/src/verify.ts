/**
 * What a service does with a session token: verify it against picasso-auth's
 * published key, and decide.
 *
 * The data plane and the gateway do the same in Go (`identity` in each
 * module), and the verdicts must agree. `test/tokens.test.ts` writes
 * `testdata/tokens.json` — tokens a fixed key signed, the moment each is
 * presented, and the verdict — and the Go tests read it. Change a rule here
 * and the Go suites say so.
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
  options: { issuer: string; now?: number },
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
  return { ok: true, session: { user: payload.sub, tenant: payload.tenant, sid: payload.sid, exp } };
}
