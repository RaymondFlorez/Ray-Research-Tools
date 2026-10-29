/**
 * Picasso's own session tokens (PRD 7.2): fifteen minutes, silently refreshed,
 * and verified by every service against this issuer's published key.
 *
 * The identity provider's ID token proves who signed in. It is not what the
 * services check on each request: it is the provider's, with the provider's
 * lifetime, and it names nothing Picasso decides. So a sign-in that passes is
 * turned into a session token here, under canvas-guard's rules, and that token
 * is what the data plane, the gateway and the collaboration server verify.
 *
 * canvas-guard's `authorizeSession` and `acceptRefresh` are the rules — MFA
 * in a tenant that holds positions, fifteen minutes, twelve hours from the
 * interactive login, and a refresh that cannot change who, where or how. This
 * file is where they are applied: at minting, at every verification, and at
 * every refresh. A token this issuer would refuse to mint, it also refuses to
 * accept.
 */

import { randomBytes } from 'node:crypto';
import { SESSION_TTL_MS, acceptRefresh, authorizeSession, type TenantProfile, type VerifiedClaims } from '@picasso/canvas-guard';
import { SignJWT, exportJWK, generateKeyPair, importJWK, jwtVerify, type CryptoKey, type JWK } from 'jose';

export const AUDIENCE = 'picasso';
const ALG = 'EdDSA';

export interface Session extends VerifiedClaims {
  /** The session's id, shared by every token refreshed from one sign-in. */
  sid: string;
}

export class SessionRefused extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'SessionRefused';
  }
}

export interface IssuerOptions {
  /** This service's URL: the `iss` of every token. */
  issuer: string;
  /** Tenants, and whether each holds positions data. A tenant not listed is refused. */
  tenants: Readonly<Record<string, { holdsPositions: boolean }>>;
  /** A signing key as a private JWK, to survive restarts. Absent: a new key, and every session ends at restart. */
  privateJwk?: JWK;
  now?: () => number;
}

export class SessionIssuer {
  private readonly ended = new Set<string>();
  private readonly now: () => number;

  private constructor(
    private readonly options: IssuerOptions,
    private readonly privateKey: CryptoKey,
    private readonly publicKey: CryptoKey,
    private readonly publicJwk: JWK,
  ) {
    this.now = options.now ?? Date.now;
  }

  static async create(options: IssuerOptions): Promise<SessionIssuer> {
    let privateKey: CryptoKey;
    let publicJwk: JWK;
    if (options.privateJwk) {
      privateKey = (await importJWK(options.privateJwk, ALG)) as CryptoKey;
      const { d: _secret, ...pub } = options.privateJwk;
      publicJwk = pub;
    } else {
      const pair = await generateKeyPair(ALG, { crv: 'Ed25519', extractable: true });
      privateKey = pair.privateKey;
      publicJwk = await exportJWK(pair.publicKey);
    }
    const kid = Buffer.from(JSON.stringify([publicJwk.crv, publicJwk.x])).toString('base64url').slice(0, 16);
    publicJwk = { ...publicJwk, kid, alg: ALG, use: 'sig' };
    const publicKey = (await importJWK(publicJwk, ALG)) as CryptoKey;
    return new SessionIssuer(options, privateKey, publicKey, publicJwk);
  }

  /** The public key set the services verify against. */
  jwks(): { keys: JWK[] } {
    return { keys: [this.publicJwk] };
  }

  private profile(tenant: string): TenantProfile {
    const t = this.options.tenants[tenant];
    if (!t) throw new SessionRefused('unknown_tenant', `no tenant ${tenant} is configured`);
    return { tenant, holdsPositions: t.holdsPositions };
  }

  private async sign(s: Session): Promise<string> {
    return new SignJWT({ tenant: s.tenant, amr: [...s.amr], auth_time: Math.floor(s.authTime / 1000), sid: s.sid })
      .setProtectedHeader({ alg: ALG, kid: this.publicJwk.kid! })
      .setIssuer(this.options.issuer)
      .setAudience(AUDIENCE)
      .setSubject(s.sub)
      .setIssuedAt(Math.floor(s.iat / 1000))
      .setExpirationTime(Math.floor(s.exp / 1000))
      .sign(this.privateKey);
  }

  /** A new session for a verified sign-in, or the reason there is none. */
  async mint(user: string, tenant: string, signIn: { authTime: number; amr: readonly string[] }): Promise<{ token: string; session: Session; refreshAt: number }> {
    const iat = Math.floor(this.now() / 1000) * 1000;
    const session: Session = { sub: user, tenant, iat, exp: iat + SESSION_TTL_MS, authTime: signIn.authTime, amr: [...signIn.amr], sid: randomBytes(16).toString('base64url') };
    const decision = authorizeSession(session, this.profile(tenant), this.now());
    if (!decision.ok) throw new SessionRefused(decision.reason, decision.message);
    return { token: await this.sign(session), session, refreshAt: decision.refreshAt };
  }

  /** The session a token carries, if this issuer signed it and its rules still hold. */
  async verify(token: string): Promise<Session> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.publicKey, { issuer: this.options.issuer, audience: AUDIENCE, algorithms: [ALG], clockTolerance: 30, currentDate: new Date(this.now()) }));
    } catch (err) {
      throw new SessionRefused('invalid', `the session token does not verify: ${(err as Error).message}`);
    }
    const session: Session = {
      sub: String(payload.sub), tenant: String(payload.tenant), iat: (payload.iat ?? 0) * 1000, exp: (payload.exp ?? 0) * 1000,
      authTime: Number(payload.auth_time) * 1000, amr: Array.isArray(payload.amr) ? payload.amr.map(String) : [], sid: String(payload.sid),
    };
    if (this.ended.has(session.sid)) throw new SessionRefused('ended', 'this session was logged out');
    const decision = authorizeSession(session, this.profile(session.tenant), this.now());
    if (!decision.ok) throw new SessionRefused(decision.reason, decision.message);
    return session;
  }

  /** A fresh token for a live session: same person, tenant, login and factors. */
  async refresh(token: string): Promise<{ token: string; session: Session; refreshAt: number }> {
    const current = await this.verify(token);
    const iat = Math.max(Math.floor(this.now() / 1000) * 1000, current.iat);
    const next: Session = { ...current, iat, exp: iat + SESSION_TTL_MS };
    const relation = acceptRefresh(current, next);
    if (!relation.ok) throw new SessionRefused(relation.reason, relation.message);
    const decision = authorizeSession(next, this.profile(next.tenant), this.now());
    if (!decision.ok) throw new SessionRefused(decision.reason, decision.message);
    return { token: await this.sign(next), session: next, refreshAt: decision.refreshAt };
  }

  /** Logout: this issuer refuses the session from now on. */
  end(sid: string): void {
    this.ended.add(sid);
  }
}
