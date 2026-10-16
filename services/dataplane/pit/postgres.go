package pit

import (
	"context"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
)

// Postgres is the store on Postgres: the metadata store PRD 2.3 names, and
// the one this repository can run. ClickHouse and Iceberg are where ticks and
// history live at production volume; the semantics are the same and are what
// the conformance file protects.
//
// "Append-only" is enforced by the database, twice. Triggers refuse UPDATE,
// DELETE and TRUNCATE whoever asks, and the application role is granted
// SELECT and INSERT and nothing else, so even a dropped trigger would not hand
// the service a way to rewrite history.
type Postgres struct {
	pool   *pgxpool.Pool
	schema string
}

var identifier = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

// NewPostgres uses the given schema, which Migrate must have created.
func NewPostgres(pool *pgxpool.Pool, schema string) (*Postgres, error) {
	if !identifier.MatchString(schema) {
		return nil, fmt.Errorf("schema %q is not a plain identifier", schema)
	}
	return &Postgres{pool: pool, schema: schema}, nil
}

// Migrate creates the schema, the facts table and its guards. Run it as the
// owning role, never as the service.
func Migrate(ctx context.Context, pool *pgxpool.Pool, schema string) error {
	if !identifier.MatchString(schema) {
		return fmt.Errorf("schema %q is not a plain identifier", schema)
	}
	_, err := pool.Exec(ctx, fmt.Sprintf(`
CREATE SCHEMA IF NOT EXISTS %[1]s;
CREATE TABLE IF NOT EXISTS %[1]s.facts (
  seq            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key            text COLLATE "C" NOT NULL,
  valid_time     text COLLATE "C" NOT NULL,
  knowledge_time text COLLATE "C" NOT NULL,
  value          double precision NOT NULL,
  source         text,
  restatement    boolean NOT NULL DEFAULT false,
  data_class     text NOT NULL CHECK (data_class IN ('public', 'licensed', 'positions', 'mnpi_risk')),
  vendor         text,
  CHECK (data_class <> 'licensed' OR vendor IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS facts_asof ON %[1]s.facts (key, valid_time, knowledge_time DESC, seq DESC);
CREATE OR REPLACE FUNCTION %[1]s.refuse_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'facts is append-only: %% refused; a correction is a new fact with a later knowledge time', TG_OP;
END $$;
CREATE OR REPLACE TRIGGER facts_no_rewrite BEFORE UPDATE OR DELETE ON %[1]s.facts
  FOR EACH ROW EXECUTE FUNCTION %[1]s.refuse_rewrite();
CREATE OR REPLACE TRIGGER facts_no_truncate BEFORE TRUNCATE ON %[1]s.facts
  FOR EACH STATEMENT EXECUTE FUNCTION %[1]s.refuse_rewrite();
`, schema))
	return err
}

// GrantService gives a role exactly what the service needs: read and append.
func GrantService(ctx context.Context, pool *pgxpool.Pool, schema, role string) error {
	if !identifier.MatchString(schema) || !identifier.MatchString(role) {
		return fmt.Errorf("schema and role must be plain identifiers")
	}
	_, err := pool.Exec(ctx, fmt.Sprintf(`
GRANT USAGE ON SCHEMA %[1]s TO %[2]s;
GRANT SELECT, INSERT ON %[1]s.facts TO %[2]s;
`, schema, role))
	return err
}

func (p *Postgres) Append(ctx context.Context, facts ...Fact) error {
	for _, f := range facts {
		if err := validate(f); err != nil {
			return err
		}
	}
	rows := make([][]any, len(facts))
	for i, f := range facts {
		rows[i] = []any{f.Key, f.ValidTime, f.KnowledgeTime, f.Value, nullable(f.Source), f.Restatement, string(f.Class), nullable(f.Vendor)}
	}
	// COPY keeps the rows in order, so identity order is append order — which
	// is what breaks a tie between two versions known at the same instant.
	_, err := p.pool.CopyFrom(ctx, pgx.Identifier{p.schema, "facts"},
		[]string{"key", "valid_time", "knowledge_time", "value", "source", "restatement", "data_class", "vendor"},
		pgx.CopyFromRows(rows))
	return err
}

func (p *Postgres) AsOf(ctx context.Context, q Query) ([]Observation, error) {
	rows, err := p.pool.Query(ctx, fmt.Sprintf(`
SELECT DISTINCT ON (valid_time) valid_time, value, knowledge_time, coalesce(source, ''), data_class, coalesce(vendor, '')
FROM %s.facts
WHERE key = $1 AND knowledge_time <= $2
  AND ($3::text IS NULL OR valid_time >= $3)
  AND ($4::text IS NULL OR valid_time <= $4)
ORDER BY valid_time, knowledge_time DESC, seq DESC`, p.schema), q.Key, q.KnowledgeTime, q.From, q.To)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Observation{}
	for rows.Next() {
		var o Observation
		var class string
		if err := rows.Scan(&o.ValidTime, &o.Value, &o.KnownAt, &o.Source, &class, &o.Vendor); err != nil {
			return nil, err
		}
		o.Class = entitle.Class(class)
		out = append(out, o)
	}
	return out, rows.Err()
}

func (p *Postgres) History(ctx context.Context, key, validTime string) ([]Fact, error) {
	rows, err := p.pool.Query(ctx, fmt.Sprintf(`
SELECT key, valid_time, knowledge_time, value, coalesce(source, ''), restatement, data_class, coalesce(vendor, '')
FROM %s.facts WHERE key = $1 AND valid_time = $2 ORDER BY knowledge_time, seq`, p.schema), key, validTime)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Fact
	for rows.Next() {
		var f Fact
		var class string
		if err := rows.Scan(&f.Key, &f.ValidTime, &f.KnowledgeTime, &f.Value, &f.Source, &f.Restatement, &class, &f.Vendor); err != nil {
			return nil, err
		}
		f.Class = entitle.Class(class)
		out = append(out, f)
	}
	return out, rows.Err()
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
