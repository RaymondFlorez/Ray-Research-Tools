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
