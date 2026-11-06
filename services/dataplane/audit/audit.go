// Package audit is PRD 7.2's audit trail:
//
//	Every read of position data, every export, and every AI dispatch writes
//	an append-only audit record with actor, resource, purpose, and trace ID.
//	Audit records go to a separate store with a distinct retention policy and
//	no delete path for application service accounts.
//
// The store is its own schema. Triggers refuse UPDATE, DELETE and TRUNCATE
// from anyone, and GrantService gives the application's role INSERT and
// nothing else, so the service that writes the trail cannot read it back,
// let alone edit it. Removing records past their retention is an owner's
// deliberate act: dropping a trigger. No path exists for the application to
// take it.
//
// The callers fail closed: a record that cannot be written means the read or
// the dispatch does not happen. services/dataplane and services/gateway carry
// this package as identical copies, and CI compares them.
package audit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Record is one audited act.
type Record struct {
	At       time.Time `json:"at"`
	Actor    string    `json:"actor"`
	Tenant   string    `json:"tenant"`
	Action   string    `json:"action"`
	Resource string    `json:"resource"`
	Purpose  string    `json:"purpose"`
	TraceID  string    `json:"traceId"`
	Outcome  string    `json:"outcome"`
}

// Validate refuses a record missing what the PRD requires of every one, or
// whose purpose is not a purpose.
func (r Record) Validate() error {
	if r.Actor == "" || r.Action == "" || r.Resource == "" || r.Purpose == "" || r.TraceID == "" {
		return errors.New("an audit record names its actor, action, resource, purpose and trace id")
	}
	if err := CheckPurpose(r.Purpose); err != nil {
		return err
	}
	return nil
}

var purpose = regexp.MustCompile(`^[a-z][a-z0-9_]*(?:[.:-][a-z0-9_]+)*$`)

// CheckPurpose accepts a purpose stated as a task name, such as
// "sql.generate" or "canvas.render", of at most 64 characters. A sentence is
// refused: the trail records why, and free text is where a prompt or a
// position would end up in it.
func CheckPurpose(p string) error {
	if len(p) > 64 || !purpose.MatchString(p) {
		return fmt.Errorf("purpose %q is not a task name (lower case, dot-separated, at most 64 characters, e.g. sql.generate)", p)
	}
	return nil
}

// Store appends records. There is nothing else to do to one.
type Store interface {
	Append(ctx context.Context, r Record) error
}

// Memory is a Store for development and tests. Records reads copies.
type Memory struct {
	mu   sync.Mutex
	rows []Record
	// Fail makes every Append fail, to test that callers fail closed.
	Fail bool
}

func (m *Memory) Append(_ context.Context, r Record) error {
	if err := r.Validate(); err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.Fail {
		return errors.New("the audit store is unavailable")
	}
	m.rows = append(m.rows, r)
	return nil
}

// Records is a copy of what was appended, for tests.
func (m *Memory) Records() []Record {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]Record(nil), m.rows...)
}

var identifier = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

// DefaultRetentionDays is the minimum time a record is kept, set when the
// schema is created: seven years. The PRD asks for "a distinct retention
// policy" and names no period, so this is a default to change, not a
// requirement; SetRetention changes it, as the schema's owner.
const DefaultRetentionDays = 2557

// Migrate creates the audit schema, as its owner.
//
// Beyond append-only, three rules live in the schema. The database stamps
// each record's time, so a writer cannot backdate one into expiry. A record
// can be deleted only by expire(), only once it is older than the retention
// period in the schema's own retention table, and expire() is not granted
// to anyone but the owner. TRUNCATE and UPDATE stay refused for everyone.
func Migrate(ctx context.Context, pool *pgxpool.Pool, schema string) error {
	if !identifier.MatchString(schema) {
		return fmt.Errorf("schema %q is not a plain identifier", schema)
	}
	_, err := pool.Exec(ctx, fmt.Sprintf(`
CREATE SCHEMA IF NOT EXISTS %[1]s;
CREATE TABLE IF NOT EXISTS %[1]s.records (
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
CREATE TABLE IF NOT EXISTS %[1]s.retention (
  one boolean PRIMARY KEY DEFAULT true CHECK (one),
  min_days integer NOT NULL CHECK (min_days >= 1)
);
INSERT INTO %[1]s.retention (min_days) VALUES (%[2]d) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION %[1]s.refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%% on the audit trail is refused: it is append-only', TG_OP;
END $$;
CREATE OR REPLACE FUNCTION %[1]s.stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.at := now();
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION %[1]s.guard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('picasso.audit_expiry', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'DELETE on the audit trail is refused: it is append-only';
  END IF;
  IF OLD.at > now() - make_interval(days => (SELECT min_days FROM %[1]s.retention)) THEN
    RAISE EXCEPTION 'record %% is inside the retention period and is kept', OLD.seq;
  END IF;
  RETURN OLD;
END $$;
CREATE OR REPLACE FUNCTION %[1]s.expire() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('picasso.audit_expiry', 'on', true);
  DELETE FROM %[1]s.records WHERE at <= now() - make_interval(days => (SELECT min_days FROM %[1]s.retention));
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('picasso.audit_expiry', 'off', true);
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION %[1]s.expire() FROM PUBLIC;
DROP TRIGGER IF EXISTS stamp ON %[1]s.records;
CREATE TRIGGER stamp BEFORE INSERT ON %[1]s.records FOR EACH ROW EXECUTE FUNCTION %[1]s.stamp();
DROP TRIGGER IF EXISTS no_change ON %[1]s.records;
CREATE TRIGGER no_change BEFORE UPDATE ON %[1]s.records FOR EACH ROW EXECUTE FUNCTION %[1]s.refuse();
DROP TRIGGER IF EXISTS no_delete ON %[1]s.records;
CREATE TRIGGER no_delete BEFORE DELETE ON %[1]s.records FOR EACH ROW EXECUTE FUNCTION %[1]s.guard_delete();
DROP TRIGGER IF EXISTS no_truncate ON %[1]s.records;
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %[1]s.records FOR EACH STATEMENT EXECUTE FUNCTION %[1]s.refuse();
DROP TRIGGER IF EXISTS no_delete ON %[1]s.retention;
CREATE TRIGGER no_delete BEFORE DELETE ON %[1]s.retention FOR EACH ROW EXECUTE FUNCTION %[1]s.refuse();
DROP TRIGGER IF EXISTS no_truncate ON %[1]s.retention;
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON %[1]s.retention FOR EACH STATEMENT EXECUTE FUNCTION %[1]s.refuse();
`, schema, DefaultRetentionDays))
	return err
}

// Expire removes the records older than the retention period, and nothing
// else. It must run as the schema's owner: the application's role is not
// granted the function, and has no DELETE on the trail either.
func Expire(ctx context.Context, pool *pgxpool.Pool, schema string) (int64, error) {
	if !identifier.MatchString(schema) {
		return 0, fmt.Errorf("schema %q is not a plain identifier", schema)
	}
	var n int64
	err := pool.QueryRow(ctx, fmt.Sprintf("SELECT %s.expire()", schema)).Scan(&n)
	return n, err
}

// SetRetention changes the minimum time a record is kept, as the owner.
func SetRetention(ctx context.Context, pool *pgxpool.Pool, schema string, days int) error {
	if !identifier.MatchString(schema) {
		return fmt.Errorf("schema %q is not a plain identifier", schema)
	}
	_, err := pool.Exec(ctx, fmt.Sprintf("UPDATE %s.retention SET min_days = $1", schema), days)
	return err
}

// GrantService gives an application role INSERT on the trail and nothing
// more: not SELECT, not UPDATE, not DELETE.
func GrantService(ctx context.Context, pool *pgxpool.Pool, schema, role string) error {
	if !identifier.MatchString(schema) || !identifier.MatchString(role) {
		return fmt.Errorf("schema and role must be plain identifiers")
	}
	_, err := pool.Exec(ctx, fmt.Sprintf(`
GRANT USAGE ON SCHEMA %[1]s TO %[2]s;
GRANT INSERT ON %[1]s.records TO %[2]s;
GRANT USAGE ON SEQUENCE %[1]s.records_seq_seq TO %[2]s;
`, schema, role))
	return err
}

// Postgres is the trail in its own schema.
type Postgres struct {
	pool   *pgxpool.Pool
	schema string
}

func NewPostgres(pool *pgxpool.Pool, schema string) (*Postgres, error) {
	if !identifier.MatchString(schema) {
		return nil, fmt.Errorf("schema %q is not a plain identifier", schema)
	}
	return &Postgres{pool: pool, schema: schema}, nil
}

func (p *Postgres) Append(ctx context.Context, r Record) error {
	if err := r.Validate(); err != nil {
		return err
	}
	_, err := p.pool.Exec(ctx, fmt.Sprintf(`INSERT INTO %s.records (actor, tenant, action, resource, purpose, trace_id, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7)`, p.schema),
		r.Actor, r.Tenant, r.Action, r.Resource, r.Purpose, r.TraceID, r.Outcome)
	return err
}

// PurposeHeader is where a request states why it reads what it reads.
const PurposeHeader = "X-Picasso-Purpose"

// TraceHeader is where the trace id is returned, so the caller can cite it.
const TraceHeader = "X-Picasso-Trace"

var traceparent = regexp.MustCompile(`^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$`)

// TraceID is the request's W3C trace id from `traceparent`, or a new one.
func TraceID(r *http.Request) string {
	if m := traceparent.FindStringSubmatch(strings.TrimSpace(r.Header.Get("traceparent"))); m != nil && m[1] != strings.Repeat("0", 32) {
		return m[1]
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
