/**
 * A logout outlives a restart. Held only in memory, the revocation list ended
 * with the process: an issuer restarted with the same key accepted a
 * logged-out session's unexpired token again, and refreshed it.
 */

import { exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryRevocations, PostgresRevocations, type RevocationStore } from '../src/revocations.js';
import { REVOKED_FOR_MS, SessionIssuer } from '../src/sessions.js';

const tenants = { desk: { holdsPositions: true } };
const key = async () => exportJWK((await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true })).privateKey);

async function restartKeepsTheLogout(store: RevocationStore) {
  let now = Date.now();
  const privateJwk = await key();
  const before = await SessionIssuer.create({ issuer: 'https://picasso.example', tenants, privateJwk, revocations: store, now: () => now });
  const { token, session } = await before.mint('pm', 'desk', { authTime: now, amr: ['pwd', 'otp'] });
  await before.end(session.sid);
  now += 60_000;
  const after = await SessionIssuer.create({ issuer: 'https://picasso.example', tenants, privateJwk, revocations: store, now: () => now });
  await expect(after.verify(token)).rejects.toThrow(/logged out/);
  await expect(after.refresh(token)).rejects.toThrow(/logged out/);
  expect(after.revoked()).toContain(session.sid);
  // And it leaves the list when no token of its own could verify anywhere.
  now += REVOKED_FOR_MS;
  const later = await SessionIssuer.create({ issuer: 'https://picasso.example', tenants, privateJwk, revocations: store, now: () => now });
  expect(later.revoked()).not.toContain(session.sid);
}

describe('a logout across a restart', () => {
  it('is forgotten without a store: the same key accepts and refreshes the logged-out token', async () => {
    const privateJwk = await key();
    const before = await SessionIssuer.create({ issuer: 'https://picasso.example', tenants, privateJwk });
    const { token, session } = await before.mint('pm', 'desk', { authTime: Date.now(), amr: ['pwd', 'otp'] });
    await before.end(session.sid);
    await expect(before.verify(token)).rejects.toThrow(/logged out/);
    const after = await SessionIssuer.create({ issuer: 'https://picasso.example', tenants, privateJwk });
    expect((await after.verify(token)).sub).toBe('pm');
    expect((await after.refresh(token)).session.sid).toBe(session.sid);
  });

  it('is kept by a revocation store', async () => {
    await restartKeepsTheLogout(new MemoryRevocations());
  });

  it('holds in this process even when the store cannot take it, and says so', async () => {
    const store = new MemoryRevocations();
    const issuer = await SessionIssuer.create({ issuer: 'https://picasso.example', tenants, privateJwk: await key(), revocations: store });
    const { token, session } = await issuer.mint('pm', 'desk', { authTime: Date.now(), amr: ['pwd', 'otp'] });
    store.fail = true;
    await expect(issuer.end(session.sid)).rejects.toThrow(/unavailable/);
    await expect(issuer.verify(token)).rejects.toThrow(/logged out/);
  });
});

const URL_ = process.env.AUTH_PG_URL ?? process.env.COLLAB_PG_URL;
if (!URL_ && process.env.AUTH_REQUIRE_PG === '1') throw new Error('AUTH_REQUIRE_PG is set and no database was given');
(URL_ ? describe : describe.skip)('a logout across a restart, on Postgres', () => {
  let pool: pg.Pool;
  const schema = `auth_${Date.now().toString(36)}`;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL_ });
    await PostgresRevocations.migrate(pool, schema);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await pool.end();
  });

  it('is kept by the Postgres store, and an expired entry is cleared', async () => {
    await restartKeepsTheLogout(new PostgresRevocations(pool, schema));
  });
});
