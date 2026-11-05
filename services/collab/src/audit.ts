/**
 * PRD 7.2's audit trail, written from TypeScript.
 *
 * > Every read of position data, every export, and every AI dispatch writes
 * > an append-only audit record with actor, resource, purpose, and trace ID.
 *
 * The data plane and the gateway write the trail in Go (`audit` in each).
 * Exports are assembled here, so this writes the same trail: the same table,
 * the same triggers, the same rule for what a purpose is. Two languages
 * creating one schema is how they drift apart, so both are held to
 * `services/audit-contract.json`: the schema as Postgres describes it after
 * each side migrates, and the purposes each must accept and refuse.
 * `test/audit.test.ts` holds this side to it; the Go tests hold theirs.
 */

import { randomBytes } from 'node:crypto';
import type pg from 'pg';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const PURPOSE = /^[a-z][a-z0-9_]*(?:[.:-][a-z0-9_]+)*$/;

export interface AuditRecord {
  actor: string;
  tenant: string;
  action: string;
  resource: string;
  purpose: string;
  traceId: string;
  outcome: string;
}

/**
 * A purpose is a task name, such as `export.pdf`, of at most 64 characters.
 * A sentence is refused: free text is where a position would end up in the
 * trail.
 */
export function checkPurpose(p: string): string | undefined {
  if (p.length > 64 || !PURPOSE.test(p)) {
    return `purpose ${JSON.stringify(p)} is not a task name (lower case, dot-separated, at most 64 characters, e.g. sql.generate)`;
  }
  return undefined;
}

/** The trace id from a W3C `traceparent`, or a new one. */
export function traceId(traceparent: string | undefined): string {
  const m = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec((traceparent ?? '').trim());
  if (m && m[1] !== '0'.repeat(32)) return m[1]!;
  return randomBytes(16).toString('hex');
}

/** Creates the trail's schema, as its owner: the Go `audit.Migrate`, statement for statement. */
export async function migrateAudit(pool: pg.Pool, schema: string): Promise<void> {
  if (!IDENT.test(schema)) throw new Error(`schema ${JSON.stringify(schema)} is not a plain identifier`);
  await pool.query(`
CREATE SCHEMA IF NOT EXISTS ${schema};
CREATE TABLE IF NOT EXISTS ${schema}.records (
  seq bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (actor <> ''),
  tenant text NOT NULL,
  action text NOT NULL CHECK (action <> ''),
  resource text NOT NULL CHECK (resource <> ''),
  purpose text NOT NULL CHECK (purpose <> ''),
  trace_id text NOT NULL CHECK (trace_id <> ''),
  outcome text NOT NULL
);
CREATE OR REPLACE FUNCTION ${schema}.refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on the audit trail is refused: it is append-only', TG_OP;
END $$;
DROP TRIGGER IF EXISTS no_change ON ${schema}.records;
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE ON ${schema}.records FOR EACH ROW EXECUTE FUNCTION ${schema}.refuse();
DROP TRIGGER IF EXISTS no_truncate ON ${schema}.records;
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ${schema}.records FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.refuse();
`);
}

/** Appends records. There is nothing else to do to one. */
export interface AuditStore {
  append(record: AuditRecord): Promise<void>;
}

function validate(r: AuditRecord): void {
  if (!r.actor || !r.action || !r.resource || !r.purpose || !r.traceId) {
    throw new Error('an audit record names its actor, action, resource, purpose and trace id');
  }
  const bad = checkPurpose(r.purpose);
  if (bad) throw new Error(bad);
}

export class PostgresAudit implements AuditStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly schema: string,
  ) {
    if (!IDENT.test(schema)) throw new Error(`schema ${JSON.stringify(schema)} is not a plain identifier`);
  }

  async append(r: AuditRecord): Promise<void> {
    validate(r);
    await this.pool.query(
      `INSERT INTO ${this.schema}.records (actor, tenant, action, resource, purpose, trace_id, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [r.actor, r.tenant, r.action, r.resource, r.purpose, r.traceId, r.outcome],
    );
  }
}

/** For development and tests. `fail` makes every append fail, to test that callers fail closed. */
export class MemoryAudit implements AuditStore {
  private readonly rows: AuditRecord[] = [];
  fail = false;

  async append(r: AuditRecord): Promise<void> {
    validate(r);
    if (this.fail) throw new Error('the audit store is unavailable');
    this.rows.push({ ...r });
  }

  records(): AuditRecord[] {
    return this.rows.map((r) => ({ ...r }));
  }
}
