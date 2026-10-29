import { createRemoteJWKSet, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Oidc } from '../src/oidc.js';
import { SESSION_COOKIE, startAuth } from '../src/server.js';
import { AUDIENCE, SessionIssuer } from '../src/sessions.js';
import { startStandIn, type StandInOptions } from '../src/standin.js';

const CLIENT = 'picasso-web';
const users = { pm: { tenant: 'desk' }, analyst: { tenant: 'desk' }, researcher: { tenant: 'lab' } };
const tenants = { desk: { holdsPositions: true }, lab: { holdsPositions: false } };
const standInUsers: StandInOptions['users'] = {
  pm: { amr: ['pwd', 'otp'] },
  analyst: { amr: ['pwd'] },
  researcher: { amr: ['pwd'] },
  intern: { amr: ['pwd', 'otp'] },
};

/** A browser, as far as cookies and redirects go. */
class Browser {
  jar = new Map<string, string>();
  async go(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = pair!.split('=');
      if (attrs.some((a) => a.trim() === 'Max-Age=0')) this.jar.delete(k!.trim());
      else this.jar.set(k!.trim(), v!.trim());
    }
    return res;
  }
  /** Follows redirects through the provider and back; returns where it landed. */
  async signIn(auth: string, user: string, returnTo = '/apps/canvas-demo/shared.html'): Promise<URL> {
    let res = await this.go(`${auth}/auth/login?return=${encodeURIComponent(returnTo)}&login_hint=${user}`);
    for (let i = 0; i < 5 && res.status === 302; i += 1) {
      const loc = new URL(res.headers.get('location')!, auth);
      if (loc.pathname.startsWith('/apps/') || loc.pathname === '/') return loc;
      res = await this.go(loc.toString());
    }
    throw new Error(`sign-in ended at ${res.status}`);
  }
}

async function setup(misbehave?: StandInOptions['misbehave'], now?: () => number) {
  // The relying party's redirect URI is known before its port is; reserve it via a fixed port.
  const port = 18000 + Math.floor(Math.random() * 2000);
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const idp = await startStandIn({ clientId: CLIENT, redirectUris: [redirectUri], users: standInUsers, ...(misbehave ? { misbehave } : {}) });
  const issuer = await SessionIssuer.create({ issuer: `http://127.0.0.1:${port}`, tenants, ...(now ? { now } : {}) });
  const oidc = new Oidc({ issuer: idp.issuer, clientId: CLIENT, redirectUri });
  const auth = await startAuth({ oidc, issuer, users, secure: false, ...(now ? { now } : {}) }, port);
  return { idp, issuer, auth, url: auth.url };
}

describe('signing in', () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    s = await setup();
  });
  afterAll(async () => {
    s.auth.server.close();
    await s.idp.close();
  });

  it('a user with a second factor gets a session any service can verify against the published key', async () => {
    const b = new Browser();
    const landed = await b.signIn(s.url, 'pm');
    expect(landed.pathname).toBe('/apps/canvas-demo/shared.html');
    expect(landed.searchParams.get('auth_error')).toBeNull();
    const token = b.jar.get(SESSION_COOKIE)!;
    // What a service does: verify against the JWKS, nothing else.
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(`${s.url}/.well-known/jwks.json`)), { issuer: s.url, audience: AUDIENCE });
    expect(payload.sub).toBe('pm');
    expect(payload.tenant).toBe('desk');
    expect(payload.exp! - payload.iat!).toBe(15 * 60);
    expect(await (await b.go(`${s.url}/auth/me`)).json()).toMatchObject({ signedIn: true, user: 'pm', tenant: 'desk', amr: ['pwd', 'otp'] });
  });

  it('a password alone is refused in a tenant that holds positions, and allowed in one that does not', async () => {
    const b = new Browser();
    const landed = await b.signIn(s.url, 'analyst');
    expect(landed.searchParams.get('auth_error')).toMatch(/holds positions data, so every session in it needs a second factor/);
    expect(b.jar.has(SESSION_COOKIE)).toBe(false);
    const r = new Browser();
    expect((await r.signIn(s.url, 'researcher')).searchParams.get('auth_error')).toBeNull();
    expect(r.jar.has(SESSION_COOKIE)).toBe(true);
  });

  it('a person the provider knows and Picasso does not is refused', async () => {
    const b = new Browser();
    expect((await b.signIn(s.url, 'intern')).searchParams.get('auth_error')).toBe('intern has no Picasso account');
  });

  it('a callback finishes only the sign-in its own browser started, and only once', async () => {
    const attacker = new Browser();
    const toIdp = await attacker.go(`${s.url}/auth/login?login_hint=pm`);
    const callback = (await attacker.go(toIdp.headers.get('location')!)).headers.get('location')!;
    // The attacker sends the callback to someone else.
    const victim = new Browser();
    const res = await victim.go(callback);
    expect(new URL(res.headers.get('location')!, s.url).searchParams.get('auth_error')).toBe('this sign-in was started in another browser');
    expect(victim.jar.has(SESSION_COOKIE)).toBe(false);
    // And it is spent: the attacker cannot use it either.
    const again = await attacker.go(callback);
    expect(new URL(again.headers.get('location')!, s.url).searchParams.get('auth_error')).toMatch(/already been used/);
  });

  it('the return address is always a path on this site', async () => {
    for (const evil of ['//evil.example/x', 'https://evil.example/', '/\\evil.example']) {
      const b = new Browser();
      expect((await b.signIn(s.url, 'pm', evil)).toString()).toBe(`${s.url}/`);
    }
  });

  it('logout ends the session for this issuer', async () => {
    const b = new Browser();
    await b.signIn(s.url, 'pm');
    const token = b.jar.get(SESSION_COOKIE)!;
    await b.go(`${s.url}/auth/logout`, { method: 'POST' });
    expect(b.jar.has(SESSION_COOKIE)).toBe(false);
    b.jar.set(SESSION_COOKIE, token);
    expect(await (await b.go(`${s.url}/auth/me`)).json()).toMatchObject({ signedIn: false });
    expect((await b.go(`${s.url}/auth/refresh`, { method: 'POST' })).status).toBe(401);
  });
});

describe('a provider that gets it wrong', () => {
  for (const [what, misbehave, expected] of [
    ['an ID token signed by a key not in its JWKS', { foreignKey: true }, /sign-in failed: .*signature/],
    ['an ID token for another audience', { audience: 'someone-else' }, /sign-in failed: .*aud/],
    ['an ID token with another sign-in\'s nonce', { nonce: 'replayed' }, /not issued for this browser/],
  ] as const) {
    it(`is refused: ${what}`, async () => {
      const s = await setup(misbehave);
      const b = new Browser();
      expect((await b.signIn(s.url, 'pm')).searchParams.get('auth_error')).toMatch(expected);
      expect(b.jar.has(SESSION_COOKIE)).toBe(false);
      s.auth.server.close();
      await s.idp.close();
    });
  }

  it('is refused when its discovery document names another issuer', async () => {
    const s = await setup({ wrongIssuer: true });
    const res = await new Browser().go(`${s.url}/auth/login?login_hint=pm`);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/names issuer .*elsewhere/);
    s.auth.server.close();
    await s.idp.close();
  });
});

describe('silent refresh', () => {
  it('extends a live session with the same login and factors, and stops twelve hours after the login', async () => {
    let clock = Date.now();
    const s = await setup(undefined, () => clock);
    const b = new Browser();
    await b.signIn(s.url, 'pm');
    const first = b.jar.get(SESSION_COOKIE)!;
    clock += 14 * 60_000;
    const refreshed = await b.go(`${s.url}/auth/refresh`, { method: 'POST' });
    expect(refreshed.status).toBe(200);
    const second = b.jar.get(SESSION_COOKIE)!;
    expect(second).not.toBe(first);
    const a = await s.issuer.verify(second);
    expect(a.authTime).toBe((await s.issuer.verify(first).catch(() => a)).authTime);
    // A token past its fifteen minutes cannot be refreshed: log in again.
    clock += 16 * 60_000;
    expect((await b.go(`${s.url}/auth/refresh`, { method: 'POST' })).status).toBe(401);
    // Refreshing every fourteen minutes reaches the twelve-hour wall.
    const c = new Browser();
    clock = Date.now();
    await c.signIn(s.url, 'pm');
    let last = 200;
    let refreshes = 0;
    while (last === 200 && refreshes < 100) {
      clock += 14 * 60_000;
      last = (await c.go(`${s.url}/auth/refresh`, { method: 'POST' })).status;
      if (last === 200) refreshes += 1;
    }
    expect(last).toBe(401);
    // 12 hours / 14 minutes: the 52nd refresh, at 12h08m, is past the wall.
    expect(refreshes).toBe(51);
    s.auth.server.close();
    await s.idp.close();
  });
});
