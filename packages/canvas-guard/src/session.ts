/**
 * Session policy (PRD 7.2, "Auth and audit").
 *
 * > OIDC with mandatory MFA for any tenant with `positions` class data.
 * > Short-lived (15 minute) session tokens with silent refresh.
 *
 * This module decides what a *verified* token is allowed to do. Verifying it —
 * the signature, the issuer, the audience, the key rotation — is the OIDC
 * library's job and is not reimplemented here; a hand-rolled JWT verifier is a
 * well-documented way to accept `alg: none`. What arrives is claims that have
 * already been checked, and what leaves is a decision.
 *
 * Four decisions, three of which the sentence above does not spell out.
 *
 * ## MFA is a property of the tenant, not of the request
 *
 * "Any tenant with positions class data" is the literal reading, and the
 * stronger one: a user in such a tenant needs MFA to open a *public* canvas
 * too. The per-request reading — MFA only when the request touches positions —
 * leaves a single-factor session sitting inside a tenant that holds positions,
 * one authorization bug away from them. The whole point of a second factor is
 * to not depend on every other check being right.
 *
 * ## A token that lives too long is refused, not trusted
 *
 * The fifteen minutes is enforced on the token, not assumed of the issuer. An
 * identity provider misconfigured to issue eight-hour tokens produces tokens
 * that verify perfectly, and a policy that only checked `exp` would honour
 * every one of them.
 *
 * ## Refresh can extend a session, and cannot upgrade one
 *
 * Silent refresh swaps a token for a newer one without the user. It keeps the
 * original authentication time and methods; a refreshed token that suddenly
 * claims `mfa` with the same `auth_time` is claiming a second factor nobody
 * presented, and is refused.
 *
 * ## Silent refresh has an end — which the PRD does not state
 *
 * Fifteen-minute tokens with unlimited silent refresh are an unlimited session
 * with more network traffic. So a session older than `MAX_SESSION_AGE_MS` from
 * its interactive login must log in again. Twelve hours is a choice made here,
 * not a figure from the specification, and the README says so.
 */

/** PRD 7.2: "Short-lived (15 minute) session tokens." */
export const SESSION_TTL_MS = 15 * 60_000;

/** Refresh this long before expiry, so no request is ever sent with a dead token. */
export const REFRESH_LEAD_MS = 2 * 60_000;

/** Clock skew tolerated between the issuer and this service. */
export const CLOCK_SKEW_MS = 30_000;

/**
 * The longest a session may run on silent refresh before an interactive login.
 *
 * Not in the PRD. Without it, fifteen-minute tokens with silent refresh are a
 * session that never ends.
 */
export const MAX_SESSION_AGE_MS = 12 * 3_600_000;

/**
 * RFC 8176 authentication method references that count as a second factor
 * alongside a knowledge factor.
 *
 * `sms` counts, because the PRD asks for MFA and not for phishing-resistant
 * MFA. That is a narrower requirement than some tenants will want, and the
 * README says so rather than quietly tightening it.
 */
const POSSESSION_OR_INHERENCE = new Set([
  'otp', 'hwk', 'swk', 'sms', 'sc', 'fpt', 'face', 'iris', 'retina', 'vbm',
]);
const KNOWLEDGE = new Set(['pwd', 'pin', 'kba']);

/** Claims from a token whose signature, issuer and audience have already been verified. */
export interface VerifiedClaims {
  sub: string;
  tenant: string;
  /** Issued at, milliseconds. */
  iat: number;
  /** Expires at, milliseconds. */
  exp: number;
  /** When the user last logged in interactively, milliseconds. OIDC `auth_time`. */
  authTime: number;
  /** RFC 8176 method references. */
  amr: readonly string[];
}

export interface TenantProfile {
  tenant: string;
  /** Whether any `positions` class data lives in this tenant. */
  holdsPositions: boolean;
}

export type SessionRefusal =
  | 'wrong_tenant'
  | 'not_yet_valid'
  | 'expired'
  | 'lifetime_too_long'
  | 'mfa_required'
  | 'session_too_old';

export type SessionDecision =
  | { ok: true; refreshAt: number; mustReauthenticateBy: number }
  | { ok: false; reason: SessionRefusal; message: string };

/**
 * Whether the methods add up to more than one factor.
 *
 * `mfa` itself is RFC 8176's statement that more than one was used. Otherwise
 * it takes one knowledge factor and one possession or inherence factor: two
 * passwords are one factor twice.
 */
export function isMultiFactor(amr: readonly string[]): boolean {
  if (amr.includes('mfa')) return true;
  const knowledge = amr.some((m) => KNOWLEDGE.has(m));
  const other = amr.some((m) => POSSESSION_OR_INHERENCE.has(m));
  return knowledge && other;
}

function refuse(reason: SessionRefusal, message: string): SessionDecision {
  return { ok: false, reason, message };
}

/** Whether these claims may act in this tenant, now. */
export function authorizeSession(
  claims: VerifiedClaims,
  tenant: TenantProfile,
  now: number,
): SessionDecision {
  if (claims.tenant !== tenant.tenant) {
    return refuse('wrong_tenant', `the session is for ${claims.tenant}, not ${tenant.tenant}`);
  }
  if (claims.exp - claims.iat > SESSION_TTL_MS) {
    return refuse(
      'lifetime_too_long',
      `the token lives ${Math.round((claims.exp - claims.iat) / 60_000)} minutes against a limit of 15; ` +
        'the identity provider is misconfigured, and the token is not honoured because it verifies',
    );
  }
  if (now + CLOCK_SKEW_MS < claims.iat) {
    return refuse('not_yet_valid', 'the token was issued in the future');
  }
  if (now >= claims.exp + CLOCK_SKEW_MS) {
    return refuse('expired', 'the token has expired');
  }
  const deadline = claims.authTime + MAX_SESSION_AGE_MS;
  if (now >= deadline) {
    return refuse('session_too_old', 'twelve hours since the last interactive login; log in again');
  }
  if (tenant.holdsPositions && !isMultiFactor(claims.amr)) {
    return refuse(
      'mfa_required',
      `${tenant.tenant} holds positions data, so every session in it needs a second factor — ` +
        'including one that only wants to read a public canvas',
    );
  }
  return {
    ok: true,
    refreshAt: Math.min(claims.exp - REFRESH_LEAD_MS, deadline),
    mustReauthenticateBy: deadline,
  };
}

export type RefreshRefusal =
  | 'different_subject'
  | 'different_tenant'
  | 'older_token'
  | 'older_login'
  | 'factor_added_without_login'
  | 'factor_dropped';

export type RefreshDecision =
  | { ok: true }
  | { ok: false; reason: RefreshRefusal; message: string };

/**
 * Whether a silently refreshed token may replace the current one.
 *
 * Checked in addition to `authorizeSession` on the new token, not instead of
 * it: this is about the *relationship* between the two.
 */
export function acceptRefresh(current: VerifiedClaims, next: VerifiedClaims): RefreshDecision {
  if (next.sub !== current.sub) {
    return { ok: false, reason: 'different_subject', message: 'a refresh cannot change who is logged in' };
  }
  if (next.tenant !== current.tenant) {
    return { ok: false, reason: 'different_tenant', message: 'a refresh cannot move a session between tenants' };
  }
  if (next.iat < current.iat) {
    return { ok: false, reason: 'older_token', message: 'the refreshed token is older than the current one' };
  }
  if (next.authTime < current.authTime) {
    // A token from a session that predates this one's login is not a refresh
    // of it, whatever else matches.
    return { ok: false, reason: 'older_login', message: 'the refreshed token belongs to an earlier login' };
  }
  if (next.authTime === current.authTime) {
    // No interactive login happened in between, so the methods cannot have
    // changed. Gaining a factor is a factor nobody presented.
    if (isMultiFactor(next.amr) && !isMultiFactor(current.amr)) {
      return {
        ok: false,
        reason: 'factor_added_without_login',
        message: 'the refreshed token claims a second factor that was never presented',
      };
    }
    if (!isMultiFactor(next.amr) && isMultiFactor(current.amr)) {
      return { ok: false, reason: 'factor_dropped', message: 'the refreshed token lost the second factor' };
    }
  }
  return { ok: true };
}
