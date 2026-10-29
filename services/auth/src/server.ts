/**
 * picasso-auth: sign-in, the session cookie, silent refresh, logout, and the
 * public key the other services verify against.
 *
 *   GET  /auth/login?return=/path[&login_hint=]   → the provider
 *   GET  /auth/callback                           → back from it; sets the session
 *   POST /auth/refresh                            → a fresh token for a live session
 *   POST /auth/logout
 *   GET  /auth/me
 *   GET  /.well-known/jwks.json
 *
 * Three rules beyond the OIDC flow itself:
 *
 *   - **A callback finishes only the sign-in this browser started.** /login
 *     sets a one-time cookie holding the state, and /callback requires it. A
 *     link an attacker started and sent to someone else would otherwise sign
 *     the victim in as the attacker.
 *   - **The return address is a path on this site.** Anything else — another
 *     host, `//host`, a scheme — is replaced by `/`, so /login is not an open
 *     redirect.
 *   - **The session is a cookie no script can read**: HttpOnly, and
 *     SameSite=Lax, which keeps it off other sites' POSTs and subrequests
 *     while letting it arrive with the browser's navigation back from the
 *     provider. Strict would drop it on that navigation.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Oidc } from './oidc.js';
import { SessionRefused, type SessionIssuer } from './sessions.js';

export const SESSION_COOKIE = 'picasso_session';
const SIGNIN_COOKIE = 'picasso_signin';
const SIGNIN_WINDOW_MS = 10 * 60_000;

export interface AuthOptions {
  oidc: Oidc;
  issuer: SessionIssuer;
  /** Users as the provider names them (preferred_username, email or sub), and their tenant. */
  users: Readonly<Record<string, { tenant: string }>>;
  /** Whether cookies need `Secure`: true whenever the site is served over https. */
  secure: boolean;
  now?: () => number;
}

interface Pending {
  nonce: string;
  verifier: string;
  returnTo: string;
  expires: number;
}

export function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function safeReturn(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  return raw;
}

export function startAuth(options: AuthOptions, port = 0, address = '127.0.0.1'): Promise<{ server: Server; url: string }> {
  const now = options.now ?? Date.now;
  const pending = new Map<string, Pending>();
  const cookie = (name: string, value: string, maxAgeS: number) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${options.secure ? '; Secure' : ''}`;

  const json = (res: ServerResponse, status: number, body: unknown, setCookie?: string[]) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(setCookie ? { 'set-cookie': setCookie } : {}) });
    res.end(JSON.stringify(body));
  };
  const redirect = (res: ServerResponse, to: string, setCookie: string[] = []) => {
    res.writeHead(302, { location: to, 'cache-control': 'no-store', 'set-cookie': setCookie });
    res.end();
  };
  const back = (res: ServerResponse, returnTo: string, error: string, extra: string[] = []) => {
    const sep = returnTo.includes('?') ? '&' : '?';
    redirect(res, `${returnTo}${sep}auth_error=${encodeURIComponent(error)}`, [cookie(SIGNIN_COOKIE, '', 0), ...extra]);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://auth');
    if (req.method === 'GET' && url.pathname === '/.well-known/jwks.json') {
      json(res, 200, options.issuer.jwks());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/login') {
      const returnTo = safeReturn(url.searchParams.get('return'));
      const hint = url.searchParams.get('login_hint') ?? undefined;
      const start = await options.oidc.begin(hint);
      for (const [k, p] of pending) if (p.expires < now()) pending.delete(k);
      pending.set(start.state, { nonce: start.nonce, verifier: start.verifier, returnTo, expires: now() + SIGNIN_WINDOW_MS });
      redirect(res, start.url, [cookie(SIGNIN_COOKIE, start.state, SIGNIN_WINDOW_MS / 1000)]);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/callback') {
      const state = url.searchParams.get('state') ?? '';
      const p = pending.get(state);
      pending.delete(state);
      if (!p) {
        back(res, '/', 'this sign-in link has already been used or was never issued');
        return;
      }
      if (cookies(req)[SIGNIN_COOKIE] !== state) {
        back(res, p.returnTo, 'this sign-in was started in another browser');
        return;
      }
      if (p.expires < now()) {
        back(res, p.returnTo, 'the sign-in took longer than ten minutes; start it again');
        return;
      }
      const providerError = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (providerError || !code) {
        back(res, p.returnTo, `the provider did not sign you in: ${providerError ?? 'no code'}`);
        return;
      }
      try {
        const identity = await options.oidc.finish(code, p.verifier, p.nonce);
        const user = options.users[identity.username];
        if (!user) {
          back(res, p.returnTo, `${identity.username} has no Picasso account`);
          return;
        }
        const minted = await options.issuer.mint(identity.username, user.tenant, identity);
        redirect(res, p.returnTo, [cookie(SIGNIN_COOKIE, '', 0), cookie(SESSION_COOKIE, minted.token, 15 * 60)]);
      } catch (err) {
        back(res, p.returnTo, err instanceof SessionRefused ? err.message : `sign-in failed: ${(err as Error).message}`);
      }
      return;
    }
    const token = cookies(req)[SESSION_COOKIE];
    if (req.method === 'POST' && url.pathname === '/auth/refresh') {
      try {
        const next = await options.issuer.refresh(token ?? '');
        json(res, 200, { user: next.session.sub, tenant: next.session.tenant, refreshAt: next.refreshAt, expires: next.session.exp }, [cookie(SESSION_COOKIE, next.token, 15 * 60)]);
      } catch (err) {
        json(res, 401, { error: (err as Error).message }, [cookie(SESSION_COOKIE, '', 0)]);
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      try {
        options.issuer.end((await options.issuer.verify(token ?? '')).sid);
      } catch {
        // Logging out of a session that is already over is not an error.
      }
      json(res, 200, { signedOut: true }, [cookie(SESSION_COOKIE, '', 0)]);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/auth/me') {
      // Signed out is an answer, not an error: a page asks before it knows.
      if (!token) {
        json(res, 200, { signedIn: false });
        return;
      }
      try {
        const s = await options.issuer.verify(token);
        json(res, 200, { signedIn: true, user: s.sub, tenant: s.tenant, amr: s.amr, expires: s.exp });
      } catch (err) {
        json(res, 200, { signedIn: false, reason: (err as Error).message }, [cookie(SESSION_COOKIE, '', 0)]);
      }
      return;
    }
    json(res, 404, { error: 'not found' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) json(res, 500, { error: (err as Error).message });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, address, () => {
      const a = server.address();
      resolve({ server, url: `http://${address}:${typeof a === 'object' && a ? a.port : port}` });
    });
  });
}
