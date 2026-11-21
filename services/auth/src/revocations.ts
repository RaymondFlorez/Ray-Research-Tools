/**
 * Where logged-out sessions are kept, so a restart does not bring them back.
 *
 * The issuer refuses a logged-out session and publishes it for the services
 * until no token of its own can verify anywhere. Held only in memory, that
 * list ended with the process: restarted with the same signing key, the
 * issuer accepted a logged-out session's unexpired token again, and would
 * refresh it, so a token taken from a browser before its owner logged out
 * became a live session for the rest of its twelve hours. The test that
 * restarts an issuer shows it.
 */

import type pg from 'pg';

export interface RevocationStore {
  /** Records a logged-out session until the time given, in ms. Resolves once it is durable. */
  add(sid: string, untilMs: number): Promise<void>;
  /** The sessions still to be refused at `nowMs`, and until when. */
  live(nowMs: number): Promise<Array<[sid: string, untilMs: number]>>;
}

/** For tests, and a single process that accepts losing the list at exit. */
export class MemoryRevocations implements RevocationStore {
  private readonly rows = new Map<string, number>();
  fail = false;

  async add(sid: string, untilMs: number): Promise<void> {
    if (this.fail) throw new Error('the revocation store is unavailable');
    this.rows.set(sid, Math.max(untilMs, this.rows.get(sid) ?? 0));
  }

  async live(nowMs: number): Promise<Array<[string, number]>> {
    return [...this.rows].filter(([, until]) => until > nowMs);
  }
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export class PostgresRevocations implements RevocationStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly schema: string,
  ) {
    if (!IDENT.test(schema)) throw new Error(`schema ${JSON.stringify(schema)} is not a plain identifier`);
  }

  static async migrate(pool: pg.Pool, schema: string): Promise<void> {
    if (!IDENT.test(schema)) throw new Error(`schema ${JSON.stringify(schema)} is not a plain identifier`);
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema};
CREATE TABLE IF NOT EXISTS ${schema}.revoked_sessions (sid text PRIMARY KEY CHECK (sid <> ''), until timestamptz NOT NULL);`);
  }

  async add(sid: string, untilMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.revoked_sessions (sid, until) VALUES ($1, to_timestamp($2 / 1000.0))
       ON CONFLICT (sid) DO UPDATE SET until = GREATEST(${this.schema}.revoked_sessions.until, EXCLUDED.until)`,
      [sid, untilMs],
    );
  }

  async live(nowMs: number): Promise<Array<[string, number]>> {
    await this.pool.query(`DELETE FROM ${this.schema}.revoked_sessions WHERE until <= to_timestamp($1 / 1000.0)`, [nowMs]);
    const { rows } = await this.pool.query<{ sid: string; until: Date }>(`SELECT sid, until FROM ${this.schema}.revoked_sessions`);
    return rows.map((r) => [r.sid, r.until.getTime()]);
  }
}
