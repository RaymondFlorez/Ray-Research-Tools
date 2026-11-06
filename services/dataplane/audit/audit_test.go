package audit

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestARecordNamesWhatThePRDRequires(t *testing.T) {
	m := &Memory{}
	if err := m.Append(context.Background(), Record{Actor: "pm", Action: "read", Resource: "book", TraceID: "t"}); err == nil {
		t.Error("a record with no purpose was accepted")
	}
	for _, p := range []string{"what is the pm's NVDA position?", "Sql.Generate", "sql..generate", "sql.", strings.Repeat("a", 65)} {
		if CheckPurpose(p) == nil {
			t.Errorf("purpose %q was accepted", p)
		}
	}
	for _, p := range []string{"p", "sql.generate", "canvas.render", "risk:var-99", "models.try"} {
		if err := CheckPurpose(p); err != nil {
			t.Errorf("purpose %q was refused: %v", p, err)
		}
	}
	_ = m.Append(context.Background(), Record{Actor: "pm", Action: "read", Resource: "book", Purpose: "p", TraceID: "t"})
	got := m.Records()
	got[0].Actor = "mallory"
	if m.Records()[0].Actor != "pm" {
		t.Error("Records handed out the store's own slice")
	}
}

// The database refuses every rewrite, from anyone, and the application role
// may insert and do nothing else — not even read the trail back.
func TestTheTrailCannotBeRewrittenOrRead(t *testing.T) {
	url := os.Getenv("DATAPLANE_PG_URL")
	if url == "" {
		if os.Getenv("DATAPLANE_REQUIRE_PG") == "1" {
			t.Fatal("DATAPLANE_REQUIRE_PG is set and DATAPLANE_PG_URL is not")
		}
		t.Skip("DATAPLANE_PG_URL is not set")
	}
	ctx := context.Background()
	owner, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	schema := fmt.Sprintf("audit_%d", time.Now().UnixNano())
	role := schema + "_svc"
	if err := Migrate(ctx, owner, schema); err != nil {
		t.Fatal(err)
	}
	defer owner.Exec(ctx, fmt.Sprintf("DROP SCHEMA %s CASCADE; DROP ROLE IF EXISTS %s", schema, role))
	trail, _ := NewPostgres(owner, schema)
	if err := trail.Append(ctx, Record{Actor: "pm", Tenant: "dev", Action: "read:asof", Resource: "book.NVDA", Purpose: "rebalance", TraceID: "abc", Outcome: "served"}); err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{"UPDATE %s.records SET purpose = 'x'", "DELETE FROM %s.records", "TRUNCATE %s.records"} {
		if _, err := owner.Exec(ctx, fmt.Sprintf(stmt, schema)); err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Errorf("%s: %v", strings.Fields(stmt)[0], err)
		}
	}
	// The application's role, with the triggers gone: still no path.
	if _, err := owner.Exec(ctx, fmt.Sprintf("CREATE ROLE %s LOGIN PASSWORD 'x'", role)); err != nil {
		t.Fatal(err)
	}
	if err := GrantService(ctx, owner, schema, role); err != nil {
		t.Fatal(err)
	}
	if _, err := owner.Exec(ctx, fmt.Sprintf("DROP TRIGGER no_change ON %s.records", schema)); err != nil {
		t.Fatal(err)
	}
	conn, err := owner.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, "SET ROLE "+role); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(ctx, fmt.Sprintf("INSERT INTO %s.records (actor, tenant, action, resource, purpose, trace_id, outcome) VALUES ('pm','dev','read','book','p','t','served')", schema)); err != nil {
		t.Errorf("the service role cannot write the trail: %v", err)
	}
	for _, stmt := range []string{"DELETE FROM %s.records", "UPDATE %s.records SET purpose = 'x'", "SELECT count(*) FROM %s.records"} {
		if _, err := conn.Exec(ctx, fmt.Sprintf(stmt, schema)); err == nil || !strings.Contains(err.Error(), "permission denied") {
			t.Errorf("service role %s: %v", strings.Fields(stmt)[0], err)
		}
	}
	_, _ = conn.Exec(ctx, "RESET ROLE")
}

// Retention: a record goes only through expire(), only past the period the
// schema holds, and only for the owner. A writer cannot backdate one.
func TestOnlyTheOwnerExpiresAndOnlyPastTheRetentionPeriod(t *testing.T) {
	url := os.Getenv("DATAPLANE_PG_URL")
	if url == "" {
		if os.Getenv("DATAPLANE_REQUIRE_PG") == "1" {
			t.Fatal("DATAPLANE_REQUIRE_PG is set and DATAPLANE_PG_URL is not")
		}
		t.Skip("DATAPLANE_PG_URL is not set")
	}
	ctx := context.Background()
	owner, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	schema := fmt.Sprintf("auditr_%d", time.Now().UnixNano())
	role := schema + "_svc"
	if err := Migrate(ctx, owner, schema); err != nil {
		t.Fatal(err)
	}
	defer owner.Exec(ctx, fmt.Sprintf("DROP SCHEMA %s CASCADE; DROP ROLE IF EXISTS %s", schema, role))
	exec := func(sql string) error {
		_, err := owner.Exec(ctx, fmt.Sprintf(sql, schema))
		return err
	}
	insert := "INSERT INTO %s.records (at, actor, tenant, action, resource, purpose, trace_id, outcome) VALUES (now() - interval '%s', 'pm', 'dev', 'read', 'book', 'p', 't', 'served')"

	// A writer that names an old time gets the database's.
	if err := exec(fmt.Sprintf(insert, "%s", "8 years")); err != nil {
		t.Fatal(err)
	}
	var age float64
	if err := owner.QueryRow(ctx, fmt.Sprintf("SELECT extract(epoch FROM now() - max(at)) FROM %s.records", schema)).Scan(&age); err != nil || age > 60 {
		t.Fatalf("a backdated insert kept its date: %v seconds old (%v)", age, err)
	}
	// Old records, made the only way possible: by the owner, with the stamp off.
	if err := exec("ALTER TABLE %s.records DISABLE TRIGGER stamp"); err != nil {
		t.Fatal(err)
	}
	for _, ago := range []string{"8 years", "8 years", "6 years"} {
		if err := exec(fmt.Sprintf(insert, "%s", ago)); err != nil {
			t.Fatal(err)
		}
	}
	if err := exec("ALTER TABLE %s.records ENABLE TRIGGER stamp"); err != nil {
		t.Fatal(err)
	}

	if err := exec("DELETE FROM %s.records"); err == nil || !strings.Contains(err.Error(), "append-only") {
		t.Errorf("a plain DELETE by the owner: %v", err)
	}
	// Even the owner, inside the expiry setting, cannot take a record still in its period.
	tx, _ := owner.Begin(ctx)
	_, _ = tx.Exec(ctx, "SELECT set_config('picasso.audit_expiry', 'on', true)")
	_, err = tx.Exec(ctx, fmt.Sprintf("DELETE FROM %s.records WHERE at > now() - interval '7 years'", schema))
	_ = tx.Rollback(ctx)
	if err == nil || !strings.Contains(err.Error(), "inside the retention period") {
		t.Errorf("deleting a record inside the period: %v", err)
	}

	// The service role may not run expiry at all.
	if _, err := owner.Exec(ctx, fmt.Sprintf("CREATE ROLE %s LOGIN PASSWORD 'x'", role)); err != nil {
		t.Fatal(err)
	}
	if err := GrantService(ctx, owner, schema, role); err != nil {
		t.Fatal(err)
	}
	conn, _ := owner.Acquire(ctx)
	_, _ = conn.Exec(ctx, "SET ROLE "+role)
	_, err = conn.Exec(ctx, fmt.Sprintf("SELECT %s.expire()", schema))
	_, _ = conn.Exec(ctx, "RESET ROLE")
	conn.Release()
	if err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Errorf("the service role ran expire(): %v", err)
	}

	n, err := Expire(ctx, owner, schema)
	if err != nil || n != 2 {
		t.Fatalf("expire: %d removed (%v), want the two eight-year-old records", n, err)
	}
	var left int
	_ = owner.QueryRow(ctx, fmt.Sprintf("SELECT count(*) FROM %s.records", schema)).Scan(&left)
	if left != 2 {
		t.Errorf("%d records left, want the six-year-old one and today's", left)
	}
	// Shortening the period is the owner's decision, and takes effect at the next expiry.
	if err := SetRetention(ctx, owner, schema, 5*365); err != nil {
		t.Fatal(err)
	}
	if n, _ := Expire(ctx, owner, schema); n != 1 {
		t.Errorf("after shortening to five years: %d removed, want 1", n)
	}
	if err := exec("DELETE FROM %s.retention"); err == nil {
		t.Error("the retention policy could be deleted")
	}
}
