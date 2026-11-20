/**
 * Signing in against a real OpenID provider, not the stand-in.
 *
 * `oidc-provider` (panva) is an OpenID Certified implementation of the
 * provider side. It runs here in-process with its defaults wherever a hosted
 * provider has them too: a confidential client authenticating with
 * client_secret_basic, opaque subject identifiers, RS256 ID tokens, a consent
 * step, and profile claims released from UserInfo rather than in the ID
 * token. Only the login and consent pages are ours, since those are each
 * provider's own business: login approves the person `login_hint` names, with
 * the authentication methods listed below, and consent grants what was asked.
 *
 * Two things the stand-in never showed came out of the first run. The person's
 * name is not in the ID token, so the relying party now asks UserInfo for it,
 * for the ID token's subject only. And whether `amr` is in the ID token is the
 * provider operator's choice; without it no one gets into a tenant that holds
 * positions, which is the right way to fail.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair } from 'jose';
import Provider from 'oidc-provider';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Oidc } from '../src/oidc.js';
import { SESSION_COOKIE, startAuth } from '../src/server.js';
import { SessionIssuer } from '../src/sessions.js';
import { Browser } from './browser.js';

const CLIENT = 'picasso-web';
const SECRET = 'a-client-secret-for-this-test-only-0123456789';
/** The provider's people: an opaque subject each, as hosted providers issue. */
const PEOPLE: Record<string, { sub: string; amr: string[]; email: string }> = {
  pm: { sub: '00u8f3k2v9QxLw1Hd5d7', amr: ['pwd', 'otp'], email: 'pm@desk.example' },
  analyst: { sub: '00u8f3k2v9QxLw1Hd5d8', amr: ['pwd'], email: 'analyst@desk.example' },
};
const users = { pm: { tenant: 'desk' }, analyst: { tenant: 'desk' } };
const tenants = { desk: { holdsPositions: true } };

/** `releaseAmr`: whether the operator releases how the person authenticated with every ID token, as Okta and Entra ID do by default. */
async function start({ releaseAmr, fetcher }: { releaseAmr: boolean; fetcher?: typeof fetch }) {
  const port = 20000 + Math.floor(Math.random() * 2000);
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const http: Server = createServer();
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const issuerUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const provider = new Provider(issuerUrl, {
    clients: [{ client_id: CLIENT, client_secret: SECRET, redirect_uris: [redirectUri], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'client_secret_basic' }],
    jwks: { keys: [{ ...(await exportJWK(privateKey)), alg: 'RS256', use: 'sig', kid: 'k1' }] },
    claims: { openid: releaseAmr ? ['sub', 'amr', 'auth_time'] : ['sub'], profile: ['preferred_username'], email: ['email'] },
    findAccount: async (_ctx, sub) => {
      const [name] = Object.entries(PEOPLE).find(([, p]) => p.sub === sub) ?? [];
      if (!name) return undefined;
      return { accountId: sub, claims: async () => ({ sub, preferred_username: name, email: PEOPLE[name]!.email }) };
    },
    features: { devInteractions: { enabled: false } },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
  });
  const callback = provider.callback();
  http.on('request', async (req, res) => {
    if (!req.url?.startsWith('/interaction/')) return void callback(req, res);
    try {
      const details = await provider.interactionDetails(req, res);
      if (details.prompt.name === 'login') {
        const person = PEOPLE[String(details.params.login_hint)];
        if (!person) return void (await provider.interactionFinished(req, res, { error: 'access_denied', error_description: 'unknown person' }));
        return void (await provider.interactionFinished(req, res, { login: { accountId: person.sub, amr: person.amr } }));
      }
      const grant = new provider.Grant({ accountId: details.session!.accountId, clientId: CLIENT });
      const missing = details.prompt.details as { missingOIDCScope?: string[]; missingOIDCClaims?: string[] };
      if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
      if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
      await provider.interactionFinished(req, res, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true });
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  const issuer = await SessionIssuer.create({ issuer: `http://127.0.0.1:${port}`, tenants });
  const oidc = new Oidc({ issuer: issuerUrl, clientId: CLIENT, clientSecret: SECRET, redirectUri, ...(fetcher ? { fetch: fetcher } : {}) });
  const auth = await startAuth({ oidc, issuer, users, secure: false }, port);
  return { auth, url: auth.url, close: () => new Promise<void>((r) => http.close(() => r())) };
}

describe('signing in against a certified OpenID provider', () => {
  let s: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    s = await start({ releaseAmr: true });
  });
  afterAll(async () => {
    s.auth.server.close();
    await s.close();
  });

  it('signs a person with a second factor in, by the name the provider releases', async () => {
    const b = new Browser();
    const landed = await b.signIn(s.url, 'pm');
    expect(landed.searchParams.get('auth_error')).toBeNull();
    expect(b.jar.has(SESSION_COOKIE)).toBe(true);
    expect(await (await b.go(`${s.url}/auth/me`)).json()).toMatchObject({ signedIn: true, user: 'pm', tenant: 'desk', amr: ['pwd', 'otp'] });
  });

  it('refuses a password alone in a tenant that holds positions', async () => {
    const b = new Browser();
    const landed = await b.signIn(s.url, 'analyst');
    expect(landed.searchParams.get('auth_error')).toMatch(/second factor/);
    expect(b.jar.has(SESSION_COOKIE)).toBe(false);
  });

  it('refuses a code the provider issued to another browser\'s sign-in', async () => {
    const attacker = new Browser();
    let res = await attacker.go(`${s.url}/auth/login?login_hint=pm`);
    while (res.status === 302 || res.status === 303) {
      const loc = new URL(res.headers.get('location')!, res.url);
      if (loc.pathname === '/auth/callback') break;
      res = await attacker.go(loc.toString());
    }
    const callback = new URL(res.headers.get('location')!, res.url).toString();
    const victim = new Browser();
    const out = await victim.go(callback);
    expect(new URL(out.headers.get('location')!, s.url).searchParams.get('auth_error')).toBe('this sign-in was started in another browser');
  });
});

describe('a certified provider that does not say how the person authenticated', () => {
  it('signs no one into a tenant that holds positions: no amr is not a second factor', async () => {
    const s = await start({ releaseAmr: false });
    try {
      const b = new Browser();
      expect((await b.signIn(s.url, 'pm')).searchParams.get('auth_error')).toMatch(/second factor/);
      expect(b.jar.has(SESSION_COOKIE)).toBe(false);
    } finally {
      s.auth.server.close();
      await s.close();
    }
  });
});

describe('the name UserInfo gives', () => {
  it('counts only for the subject the ID token names', async () => {
    // UserInfo's answer, altered on the way to name someone else's subject.
    const tampered = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await fetch(url, init);
      if (!String(url).endsWith('/me')) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, sub: PEOPLE.analyst!.sub }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const s = await start({ releaseAmr: true, fetcher: tampered });
    try {
      const b = new Browser();
      expect((await b.signIn(s.url, 'pm')).searchParams.get('auth_error')).toMatch(/UserInfo response names another subject/);
      expect(b.jar.has(SESSION_COOKIE)).toBe(false);
    } finally {
      s.auth.server.close();
      await s.close();
    }
  });
});
