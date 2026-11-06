/**
 * This side of `services/audit-contract.json`: the trail this package
 * migrates is the one the Go `audit` package migrates, as Postgres describes
 * them, and a purpose means the same thing in both languages.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkPurpose, migrateAudit, PostgresAudit } from '../src/audit.js';

const contract = JSON.parse(readFileSync(fileURLToPath(new URL('../../audit-contract.json', import.meta.url)), 'utf8')) as {
  queries: Record<string, string>;
  schema: Record<string, string[]>;
  purposes: { accepted: string[]; refused: string[] };
};

describe('the audit contract', () => {
  it('accepts and refuses the purposes the Go trail does', () => {
    expect(contract.purposes.accepted.filter((p) => checkPurpose(p) !== undefined)).toEqual([]);
    expect(contract.purposes.refused.filter((p) => checkPurpose(p) === undefined)).toEqual([]);
  });
});

const URL_ = process.env.COLLAB_PG_URL ?? process.env.DATAPLANE_PG_URL;
if (!URL_ && process.env.COLLAB_REQUIRE_PG === '1') throw new Error('COLLAB_REQUIRE_PG is set and no database was given');
const suite = URL_ ? describe : describe.skip;

suite('the audit trail on Postgres', () => {
  let pool: pg.Pool;
  const schema = `auditts_${Date.now().toString(36)}`;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: URL_ });
    await migrateAudit(pool, schema);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await pool.end();
  });

  it('is the schema the Go package creates, as Postgres describes both', async () => {
    expect(Object.keys(contract.schema).sort()).toEqual(Object.keys(contract.queries).sort());
    for (const [name, query] of Object.entries(contract.queries)) {
      // A query names the schema as $1, or inline as <schema> where a parameter cannot go.
      const sql = query.split('<schema>').join(schema);
      const rows = (await pool.query<Record<string, string>>(sql, sql.includes('$1') ? [schema] : [])).rows;
      const got = rows.map((row) => Object.values(row)[0]!.split(schema).join('<schema>'));
      expect({ [name]: got }).toEqual({ [name]: contract.schema[name] });
    }
  });

  it('takes a record and refuses every rewrite', async () => {
    await new PostgresAudit(pool, schema).append({ actor: 'pm', tenant: 'acme', action: 'export', resource: 'acme/morning', purpose: 'export.pdf', traceId: 'abc', outcome: 'exported' });
    for (const stmt of [`UPDATE ${schema}.records SET purpose = 'x'`, `DELETE FROM ${schema}.records`, `TRUNCATE ${schema}.records`]) {
      await expect(pool.query(stmt)).rejects.toThrow(/append-only/);
    }
    await expect(new PostgresAudit(pool, schema).append({ actor: 'pm', tenant: 'acme', action: 'export', resource: 'r', purpose: 'export the book', traceId: 't', outcome: '' })).rejects.toThrow(/not a task name/);
  });
});
