/**
 * The OIDC relying party: discovery, the authorization-code flow with PKCE
 * and a nonce, and ID-token verification.
 *
 * Any provider that publishes a discovery document works — Okta, Entra ID,
 * Google, Auth0, Keycloak. The provider is configuration; nothing here names
 * one.
 *
 * Token verification is `jose`'s, not this file's. canvas-guard's session
 * rules say why: a hand-rolled JWT verifier is a well-documented way to accept
 * `alg: none`. What this file adds is what the libraries leave to the caller:
 * the nonce, which binds the ID token to the browser that started the flow;
 * and the discipline that a sign-in link works once, within ten minutes, and
 * only for the browser it was issued to.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface OidcConfig {
  /** The provider's issuer URL; its discovery document is at `/.well-known/openid-configuration`. */
  issuer: string;
  clientId: string;
  /** Absent for a public client, which PKCE alone protects. */
  clientSecret?: string;
  /** Where the provider sends the browser back: this service's `/auth/callback`. */
  redirectUri: string;
  scope?: string;
  fetch?: typeof fetch;
}

/** What a verified ID token says about the person. */
export interface Identity {
  sub: string;
  /** The claim used to find the user: preferred_username, then email, then sub. */
  username: string;
  /** Interactive login time, ms. Absent `auth_time` reads as the token's `iat`. */
  authTime: number;
  amr: string[];
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export class Oidc {
  private metadata?: ProviderMetadata;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly fetcher: typeof fetch;

  constructor(private readonly config: OidcConfig) {
    this.fetcher = config.fetch ?? fetch;
  }

  /** Reads the discovery document, and refuses one that names another issuer. */
  async discover(): Promise<ProviderMetadata> {
    if (this.metadata) return this.metadata;
    const url = `${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await this.fetcher(url);
    if (!res.ok) throw new Error(`discovery: ${url} answered ${res.status}`);
    const meta = (await res.json()) as ProviderMetadata;
    // OIDC Discovery 1.0, section 4.3: the issuer in the document must be the one asked for.
    if (meta.issuer !== this.config.issuer) throw new Error(`discovery: the document names issuer ${meta.issuer}, not ${this.config.issuer}`);
    this.metadata = meta;
    this.jwks = createRemoteJWKSet(new URL(meta.jwks_uri));
    return meta;
  }

  /** A sign-in: the URL to send the browser to, and what must be kept to finish it. */
  async begin(loginHint?: string): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
    const meta = await this.discover();
    const state = b64url(randomBytes(24));
    const nonce = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scope ?? 'openid profile email',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (loginHint) params.set('login_hint', loginHint);
    return { url: `${meta.authorization_endpoint}?${params}`, state, nonce, verifier };
  }

  /** Exchanges the code and verifies the ID token it returns. */
  async finish(code: string, verifier: string, nonce: string): Promise<Identity> {
    const meta = await this.discover();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: verifier,
    });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (this.config.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`).toString('base64')}`;
    }
    const res = await this.fetcher(meta.token_endpoint, { method: 'POST', headers, body });
    const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    if (!res.ok || !tokens.id_token) {
      throw new Error(`the provider refused the code: ${tokens.error ?? res.status}${tokens.error_description ? ` (${tokens.error_description})` : ''}`);
    }
    const { payload } = await jwtVerify(tokens.id_token, this.jwks!, { issuer: meta.issuer, audience: this.config.clientId });
    if (payload.nonce !== nonce) throw new Error('the ID token does not carry the nonce this sign-in sent: it was not issued for this browser');
    return identityOf(payload);
  }
}

function identityOf(p: JWTPayload): Identity {
  const sub = String(p.sub ?? '');
  if (!sub) throw new Error('the ID token has no subject');
  const username = String((p.preferred_username as string | undefined) ?? (p.email as string | undefined) ?? sub);
  const iat = (p.iat ?? 0) * 1000;
  const authTime = typeof p.auth_time === 'number' ? p.auth_time * 1000 : iat;
  const amr = Array.isArray(p.amr) ? p.amr.map(String) : [];
  return { sub, username, authTime, amr };
}
