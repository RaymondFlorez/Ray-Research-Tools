/**
 * Where a canvas lives between sessions (PRD 3.9).
 *
 * > The Yjs document is the live truth; snapshots write to Postgres every 30
 * > seconds and on idle, with the full update log retained for 90 days.
 * > Named versions are immutable snapshots referencing dataset snapshot IDs.
 *
 * Three tables, each with the rule the sentence implies enforced by the
 * database rather than by this code:
 *
 *   - `updates`: every Yjs update, in order, as it arrived. Nothing is ever
 *     rewritten, and nothing younger than ninety days can be deleted — the
 *     trigger checks the row's age, so a retention job that miscounts days
 *     fails rather than eating history.
 *   - `snapshots`: the merged state at a point, with the last update it
 *     includes. A load is the latest snapshot plus every update after it, so
 *     a crash between snapshots loses nothing that reached the log.
 *   - `versions`: a named state and the dataset snapshot ids it was computed
 *     against. No UPDATE, no DELETE, no TRUNCATE: "pre-CPI" means one thing
 *     forever.
 *
 * Instants are the database's clock, not the client's.
 */

import pg from 'pg';
import * as Y from 'yjs';

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export async function migrate(pool: pg.Pool, schema: string): Promise<void> {
  if (!IDENT.test(schema)) throw new Error(`schema name ${JSON.stringify(schema)}`);
  await pool.query(`
CREATE SCHEMA IF NOT EXISTS ${schema};

CREATE TABLE IF NOT EXISTS ${schema}.updates (
  seq bigserial PRIMARY KEY,
  doc text NOT NULL,
  author text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  body bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_doc_seq ON ${schema}.updates (doc, seq);

CREATE TABLE IF NOT EXISTS ${schema}.snapshots (
  seq bigserial PRIMARY KEY,
  doc text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  through_update bigint NOT NULL,
  reason text NOT NULL,
  state bytea NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_doc_seq ON ${schema}.snapshots (doc, seq DESC);

CREATE TABLE IF NOT EXISTS ${schema}.versions (
  doc text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  author text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  dataset_snapshots jsonb NOT NULL,
  asof text NOT NULL,
  state bytea NOT NULL,
  PRIMARY KEY (doc, name)
);

CREATE OR REPLACE FUNCTION ${schema}.refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is refused: it is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
END $$;

CREATE OR REPLACE FUNCTION ${schema}.retain_90_days() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.at > now() - interval '90 days' THEN
    RAISE EXCEPTION 'row % of %.% is younger than 90 days and is retained', OLD.seq, TG_TABLE_SCHEMA, TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS no_update ON ${schema}.updates;
CREATE TRIGGER no_update BEFORE UPDATE ON ${schema}.updates FOR EACH ROW EXECUTE FUNCTION ${schema}.refuse();
DROP TRIGGER IF EXISTS retain ON ${schema}.updates;
CREATE TRIGGER retain BEFORE DELETE ON ${schema}.updates FOR EACH ROW EXECUTE FUNCTION ${schema}.retain_90_days();
DROP TRIGGER IF EXISTS no_truncate ON ${schema}.updates;
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ${schema}.updates FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.refuse();

DROP TRIGGER IF EXISTS no_update ON ${schema}.snapshots;
CREATE TRIGGER no_update BEFORE UPDATE ON ${schema}.snapshots FOR EACH ROW EXECUTE FUNCTION ${schema}.refuse();
DROP TRIGGER IF EXISTS retain ON ${schema}.snapshots;
CREATE TRIGGER retain BEFORE DELETE ON ${schema}.snapshots FOR EACH ROW EXECUTE FUNCTION ${schema}.retain_90_days();
DROP TRIGGER IF EXISTS no_truncate ON ${schema}.snapshots;
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ${schema}.snapshots FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.refuse();

DROP TRIGGER IF EXISTS no_change ON ${schema}.versions;
CREATE TRIGGER no_change BEFORE UPDATE OR DELETE ON ${schema}.versions FOR EACH ROW EXECUTE FUNCTION ${schema}.refuse();
DROP TRIGGER IF EXISTS no_truncate ON ${schema}.versions;
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON ${schema}.versions FOR EACH STATEMENT EXECUTE FUNCTION ${schema}.refuse();
`);
}

export interface VersionInfo {
  name: string;
  author: string;
  at: string;
  /**
   * source -> every dataset snapshot id a node on the canvas was computed
   * against, read from the nodes' own provenance in the state. More than one
   * id for a source means nodes pinned to different times.
   */
  datasetSnapshots: Record<string, string[]>;
  /** The canvas time, from the document's meta. */
  asof: string;
}

export class VersionExists extends Error {
  constructor(readonly doc: string, readonly versionName: string) {
    super(`"${versionName}" already names a version of ${doc}; a version is never replaced`);
    this.name = 'VersionExists';
  }
}

export class CanvasStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly schema: string,
  ) {
    if (!IDENT.test(schema)) throw new Error(`schema name ${JSON.stringify(schema)}`);
  }

  /** Appends one update; returns its position in the log. */
  async append(doc: string, author: string, update: Uint8Array): Promise<number> {
    const r = await this.pool.query<{ seq: string }>(
      `INSERT INTO ${this.schema}.updates (doc, author, body) VALUES ($1, $2, $3) RETURNING seq`,
      [doc, author, Buffer.from(update)],
    );
    return Number(r.rows[0]!.seq);
  }

  /** Records the merged state, which includes every update up to `throughUpdate`. */
  async snapshot(doc: string, state: Uint8Array, throughUpdate: number, reason: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.snapshots (doc, through_update, reason, state) VALUES ($1, $2, $3, $4)`,
      [doc, throughUpdate, reason, Buffer.from(state)],
    );
  }

  /**
   * The document as it stands: the latest snapshot, then every update logged
   * after it. Returns the state and the last update it includes.
   */
  async load(doc: string): Promise<{ state: Uint8Array | null; throughUpdate: number; replayed: number }> {
    const snap = await this.pool.query<{ state: Buffer; through_update: string }>(
      `SELECT state, through_update FROM ${this.schema}.snapshots WHERE doc = $1 ORDER BY seq DESC LIMIT 1`,
      [doc],
    );
    const base = snap.rows[0];
    const after = base ? Number(base.through_update) : 0;
    const tail = await this.pool.query<{ seq: string; body: Buffer }>(
      `SELECT seq, body FROM ${this.schema}.updates WHERE doc = $1 AND seq > $2 ORDER BY seq`,
      [doc, after],
    );
    if (!base && tail.rows.length === 0) return { state: null, throughUpdate: 0, replayed: 0 };
    const ydoc = new Y.Doc();
    if (base) Y.applyUpdate(ydoc, new Uint8Array(base.state));
    for (const row of tail.rows) Y.applyUpdate(ydoc, new Uint8Array(row.body));
    const last = tail.rows.at(-1);
    return { state: Y.encodeStateAsUpdate(ydoc), throughUpdate: last ? Number(last.seq) : after, replayed: tail.rows.length };
  }

  async createVersion(doc: string, name: string, author: string, state: Uint8Array, datasetSnapshots: Record<string, string[]>, asof: string): Promise<VersionInfo> {
    try {
      const r = await this.pool.query<{ at: Date }>(
        `INSERT INTO ${this.schema}.versions (doc, name, author, dataset_snapshots, asof, state) VALUES ($1, $2, $3, $4, $5, $6) RETURNING at`,
        [doc, name, author, JSON.stringify(datasetSnapshots), asof, Buffer.from(state)],
      );
      return { name, author, at: r.rows[0]!.at.toISOString(), datasetSnapshots, asof };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new VersionExists(doc, name);
      throw err;
    }
  }

  async versions(doc: string): Promise<VersionInfo[]> {
    const r = await this.pool.query<{ name: string; author: string; at: Date; dataset_snapshots: Record<string, string[]>; asof: string }>(
      `SELECT name, author, at, dataset_snapshots, asof FROM ${this.schema}.versions WHERE doc = $1 ORDER BY at, name`,
      [doc],
    );
    return r.rows.map((row) => ({ name: row.name, author: row.author, at: row.at.toISOString(), datasetSnapshots: row.dataset_snapshots, asof: row.asof }));
  }

  async version(doc: string, name: string): Promise<(VersionInfo & { state: Uint8Array }) | undefined> {
    const r = await this.pool.query<{ name: string; author: string; at: Date; dataset_snapshots: Record<string, string[]>; asof: string; state: Buffer }>(
      `SELECT name, author, at, dataset_snapshots, asof, state FROM ${this.schema}.versions WHERE doc = $1 AND name = $2`,
      [doc, name],
    );
    const row = r.rows[0];
    return row && { name: row.name, author: row.author, at: row.at.toISOString(), datasetSnapshots: row.dataset_snapshots, asof: row.asof, state: new Uint8Array(row.state) };
  }

  /** Counts, for health and for tests. */
  async counts(doc: string): Promise<{ updates: number; snapshots: number; versions: number }> {
    const r = await this.pool.query<{ u: string; s: string; v: string }>(
      `SELECT (SELECT count(*) FROM ${this.schema}.updates WHERE doc = $1) AS u,
              (SELECT count(*) FROM ${this.schema}.snapshots WHERE doc = $1) AS s,
              (SELECT count(*) FROM ${this.schema}.versions WHERE doc = $1) AS v`,
      [doc],
    );
    const row = r.rows[0]!;
    return { updates: Number(row.u), snapshots: Number(row.s), versions: Number(row.v) };
  }
}
