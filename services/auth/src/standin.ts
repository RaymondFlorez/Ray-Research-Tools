/**
 * A STAND-IN OpenID provider, for tests and the demo's browser check only.
 *
 * It speaks the parts of OIDC the relying party uses — discovery, a JWKS, the
 * authorization endpoint with PKCE, the token endpoint — and approves at once
 * whoever `login_hint` names, with that user's configured authentication
 * methods. There is no password and no consent screen. It is a separate entry
 * point that `main.ts` never imports, so it cannot be what a deployment signs
 * in against by accident.
 *
 * `misbehave` makes it wrong in the ways a relying party must catch.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';

export interface StandInUser {
  amr: string[];
  /** Seconds before now that the user last logged in interactively. Default 0. */
  loggedInAgoS?: number;
}

export interface StandInOptions {
  clientId: string;
  redirectUris: string[];
  users: Record<string, StandInUser>;
  misbehave?: {
    /** Discovery names a different issuer than the one asked for. */
    wrongIssuer?: boolean;
    /** ID tokens signed with a key not in the JWKS. */
    foreignKey?: boolean;
    /** ID tokens carry this nonce instead of the one sent. */
    nonce?: string;
    /** ID tokens are for this audience instead of the client. */
    audience?: string;
  };
}

export interface StandIn {
  server: Server;
  issuer: string;
  /** Codes issued and not yet redeemed. */
  outstanding(): number;
  close(): Promise<void>;
}

export async function startStandIn(o: StandInOptions, port = 0): Promise<StandIn> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const foreign = (await generateKeyPair('RS256')).privateKey;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'standin-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { user: string; clientId: string; redirectUri: string; challenge: string; nonce: string }>();
  let issuer = '';

  const sign = (claims: Record<string, unknown>, key: CryptoKey, aud: string, sub: string) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'standin-1' }).setIssuer(issuer).setAudience(aud)
      .setSubject(sub).setIssuedAt().setExpirationTime('1h').sign(key);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      send(200, {
        issuer: o.misbehave?.wrongIssuer ? `${issuer}/elsewhere` : issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
      return;
    }
    if (url.pathname === '/jwks') {
      send(200, { keys: [jwk] });
      return;
    }
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      const redirectUri = q.get('redirect_uri') ?? '';
      if (q.get('client_id') !== o.clientId || !o.redirectUris.includes(redirectUri) || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') {
        send(400, { error: 'invalid_request' });
        return;
      }
      const back = new URL(redirectUri);
      back.searchParams.set('state', q.get('state') ?? '');
      const user = q.get('login_hint') ?? '';
      if (!o.users[user]) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = randomBytes(18).toString('base64url');
        codes.set(code, { user, clientId: o.clientId, redirectUri, challenge: q.get('code_challenge') ?? '', nonce: q.get('nonce') ?? '' });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const c = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (!c || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== c.redirectUri || form.get('client_id') !== c.clientId
        || createHash('sha256').update(verifier).digest('base64url') !== c.challenge) {
        send(400, { error: 'invalid_grant' });
        return;
      }
      const u = o.users[c.user]!;
      const idToken = await sign(
        { nonce: o.misbehave?.nonce ?? c.nonce, preferred_username: c.user, amr: u.amr, auth_time: Math.floor(Date.now() / 1000) - (u.loggedInAgoS ?? 0) },
        o.misbehave?.foreignKey ? foreign : privateKey,
        o.misbehave?.audience ?? o.clientId,
        `standin|${c.user}`,
      );
      send(200, { access_token: randomBytes(18).toString('base64url'), token_type: 'Bearer', expires_in: 3600, id_token: idToken });
      return;
    }
    send(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const a = server.address();
  issuer = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : port}`;
  return { server, issuer, outstanding: () => codes.size, close: () => new Promise((r) => server.close(() => r())) };
}
