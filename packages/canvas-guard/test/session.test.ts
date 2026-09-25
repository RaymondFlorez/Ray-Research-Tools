import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_AGE_MS,
  REFRESH_LEAD_MS,
  SESSION_TTL_MS,
  acceptRefresh,
  authorizeSession,
  isMultiFactor,
  type TenantProfile,
  type VerifiedClaims,
} from '../src/session.js';

const LOGIN = Date.UTC(2026, 2, 11, 8, 0);
const MINUTE = 60_000;

function claims(overrides: Partial<VerifiedClaims> = {}): VerifiedClaims {
  return {
    sub: 'maya',
    tenant: 'desk-a',
    iat: LOGIN,
    exp: LOGIN + SESSION_TTL_MS,
    authTime: LOGIN,
    amr: ['pwd', 'hwk'],
    ...overrides,
  };
}

const positionsTenant: TenantProfile = { tenant: 'desk-a', holdsPositions: true };
const researchTenant: TenantProfile = { tenant: 'desk-a', holdsPositions: false };

describe('what counts as a second factor', () => {
  it('takes RFC 8176 mfa, or a knowledge factor with a possession or inherence one', () => {
    expect(isMultiFactor(['mfa'])).toBe(true);
    expect(isMultiFactor(['pwd', 'otp'])).toBe(true);
    expect(isMultiFactor(['pin', 'fpt'])).toBe(true);
    expect(isMultiFactor(['pwd', 'sms'])).toBe(true);
  });

  it('does not count one factor twice', () => {
    expect(isMultiFactor(['pwd'])).toBe(false);
    expect(isMultiFactor(['pwd', 'pin'])).toBe(false);
    expect(isMultiFactor(['otp', 'hwk'])).toBe(false);
    expect(isMultiFactor([])).toBe(false);
  });
});

describe('authorizing a session', () => {
  it('lets a two-factor session into a positions tenant, and says when to refresh', () => {
    const decision = authorizeSession(claims(), positionsTenant, LOGIN + 5 * MINUTE);
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.refreshAt).toBe(LOGIN + SESSION_TTL_MS - REFRESH_LEAD_MS);
      expect(decision.mustReauthenticateBy).toBe(LOGIN + MAX_SESSION_AGE_MS);
    }
  });

  it('refuses a single-factor session anywhere in a tenant that holds positions', () => {
    // Even for a request that only wants a public canvas: the factor belongs
    // to the tenant, not to the request.
    const decision = authorizeSession(claims({ amr: ['pwd'] }), positionsTenant, LOGIN + MINUTE);
    expect(decision).toMatchObject({ ok: false, reason: 'mfa_required' });
  });

  it('lets a single-factor session into a tenant with no positions', () => {
    expect(authorizeSession(claims({ amr: ['pwd'] }), researchTenant, LOGIN + MINUTE).ok).toBe(true);
  });

  it('refuses a token issued to live longer than fifteen minutes, however well it verifies', () => {
    const eightHours = claims({ exp: LOGIN + 8 * 60 * MINUTE });
    expect(authorizeSession(eightHours, positionsTenant, LOGIN + MINUTE)).toMatchObject({
      ok: false,
      reason: 'lifetime_too_long',
    });
    expect(authorizeSession(claims({ exp: LOGIN + SESSION_TTL_MS }), positionsTenant, LOGIN).ok).toBe(true);
  });

  it('refuses an expired token, allowing thirty seconds of clock skew', () => {
    const c = claims();
    expect(authorizeSession(c, positionsTenant, c.exp + 29_000).ok).toBe(true);
    expect(authorizeSession(c, positionsTenant, c.exp + 30_000)).toMatchObject({ reason: 'expired' });
  });

  it('refuses a token from the future', () => {
    expect(authorizeSession(claims(), positionsTenant, LOGIN - 31_000)).toMatchObject({
      reason: 'not_yet_valid',
    });
  });

  it('refuses a session for another tenant', () => {
    expect(authorizeSession(claims({ tenant: 'desk-b' }), positionsTenant, LOGIN)).toMatchObject({
      reason: 'wrong_tenant',
    });
  });

  it('ends silent refresh twelve hours after the interactive login', () => {
    // Fifteen-minute tokens with unlimited refresh are an unlimited session.
    const late = LOGIN + MAX_SESSION_AGE_MS;
    const fresh = claims({ iat: late - MINUTE, exp: late - MINUTE + SESSION_TTL_MS });
    expect(authorizeSession(fresh, positionsTenant, late - 30_000).ok).toBe(true);
    expect(authorizeSession(fresh, positionsTenant, late)).toMatchObject({ reason: 'session_too_old' });
  });

  it('asks for the refresh before the deadline, not after it', () => {
    const late = LOGIN + MAX_SESSION_AGE_MS;
    const c = claims({ iat: late - 5 * MINUTE, exp: late + 10 * MINUTE });
    const decision = authorizeSession(c, positionsTenant, late - 4 * MINUTE);
    expect(decision.ok && decision.refreshAt).toBe(late);
  });
});

describe('silent refresh', () => {
  const current = claims();
  const next = (overrides: Partial<VerifiedClaims> = {}) =>
    claims({ iat: LOGIN + 13 * MINUTE, exp: LOGIN + 28 * MINUTE, ...overrides });

  it('accepts a newer token for the same login', () => {
    expect(acceptRefresh(current, next())).toEqual({ ok: true });
  });

  it('refuses a refresh that claims a second factor nobody presented', () => {
    const singleFactor = claims({ amr: ['pwd'] });
    const upgraded = next({ amr: ['pwd', 'otp'] });
    expect(acceptRefresh(singleFactor, upgraded)).toMatchObject({
      ok: false,
      reason: 'factor_added_without_login',
    });
  });

  it('accepts the second factor when there was an interactive login in between', () => {
    const singleFactor = claims({ amr: ['pwd'] });
    const relogin = next({ amr: ['pwd', 'otp'], authTime: LOGIN + 12 * MINUTE });
    expect(acceptRefresh(singleFactor, relogin)).toEqual({ ok: true });
  });

  it('refuses a refresh that drops the second factor', () => {
    expect(acceptRefresh(current, next({ amr: ['pwd'] }))).toMatchObject({ reason: 'factor_dropped' });
  });

  it('refuses a change of subject, tenant, or a step backwards', () => {
    expect(acceptRefresh(current, next({ sub: 'someone-else' }))).toMatchObject({ reason: 'different_subject' });
    expect(acceptRefresh(current, next({ tenant: 'desk-b' }))).toMatchObject({ reason: 'different_tenant' });
    expect(acceptRefresh(current, next({ iat: LOGIN - MINUTE }))).toMatchObject({ reason: 'older_token' });
    expect(acceptRefresh(current, next({ authTime: LOGIN - 60 * MINUTE }))).toMatchObject({
      reason: 'older_login',
    });
  });
});
