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


/** Two picasso-auth processes behind one name, on one store: a logout on one reaches the other. */
async function twoIssuersShareLogouts(store: RevocationStore) {
  const privateJwk = await key();
  const a = await SessionIssuer.create({ issuer: 'https://picasso.example', tenants, privateJwk, revocations: store });
  const b = await SessionIssuer.create({ issuer: 'https://picasso.example', tenants, privateJwk, revocations: store });
  const { token, session } = await a.mint('pm', 'desk', { authTime: Date.now(), amr: ['pwd', 'otp'] });
  await a.end(session.sid);
  // Before b looks: it still accepts and refreshes the session a logged out.
  expect((await b.verify(token)).sub).toBe('pm');
  await b.syncRevocations();
  await expect(b.verify(token)).rejects.toThrow(/logged out/);
  await expect(b.refresh(token)).rejects.toThrow(/logged out/);
  expect(b.revoked()).toContain(session.sid);
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

  it('reaches another issuer on the same store when it next reads it', async () => {
    await twoIssuersShareLogouts(new MemoryRevocations());
  });

  it('is read again on a schedule, which keeps going after a failed read', async () => {
    const store = new MemoryRevocations();
    let reads = 0;
    // b's view of the store fails its first scheduled read, then answers.
    const flaky: RevocationStore = { add: (sid, until) => store.add(sid, until), live: (now) => (++reads === 2 ? Promise.reject(new Error('store away')) : store.live(now)) };
    const privateJwk = await key();
    const a = await SessionIssuer.create({ issuer: 'https://picasso.example', tenants, privateJwk, revocations: store });
    const b = await SessionIssuer.create({ issuer: 'https://picasso.example', tenants, privateJwk, revocations: flaky });
    const errors: unknown[] = [];
    const stop = b.syncEvery(20, (e) => errors.push(e));
    try {
      const { token, session } = await a.mint('pm', 'desk', { authTime: Date.now(), amr: ['pwd', 'otp'] });
      await a.end(session.sid);
      const deadline = Date.now() + 2_000;
      while (!b.revoked().includes(session.sid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      await expect(b.verify(token)).rejects.toThrow(/logged out/);
      expect(errors.map((e) => (e as Error).message)).toEqual(['store away']);
    } finally {
      stop();
    }
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

  it('reaches another issuer on the same Postgres store', async () => {
    await twoIssuersShareLogouts(new PostgresRevocations(pool, schema));
  });
});
