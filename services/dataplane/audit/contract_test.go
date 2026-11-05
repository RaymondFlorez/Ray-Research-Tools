package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// services/audit-contract.json holds what every writer of the trail must
// agree on: the schema Migrate creates, as Postgres describes it, and the
// purposes CheckPurpose accepts and refuses. The collaboration server writes
// the same trail from TypeScript and is held to the same file.
// UPDATE_AUDIT_CONTRACT=1 rewrites it, which is a change to the contract.
const contractFile = "../../audit-contract.json"

type contract struct {
	Note     string              `json:"note"`
	Queries  map[string]string   `json:"queries"`
	Schema   map[string][]string `json:"schema"`
	Purposes struct {
		Accepted []string `json:"accepted"`
		Refused  []string `json:"refused"`
	} `json:"purposes"`
}

func readContract(t *testing.T) contract {
	raw, err := os.ReadFile(contractFile)
	if err != nil {
		t.Fatal(err)
	}
	var c contract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	return c
}

func TestPurposesAreTheContracts(t *testing.T) {
	c := readContract(t)
	if len(c.Purposes.Accepted) == 0 || len(c.Purposes.Refused) == 0 {
		t.Fatal("the contract lists no purposes")
	}
	for _, p := range c.Purposes.Accepted {
		if err := CheckPurpose(p); err != nil {
			t.Errorf("%q: refused here, accepted by the contract (%v)", p, err)
		}
	}
	for _, p := range c.Purposes.Refused {
		if CheckPurpose(p) == nil {
			t.Errorf("%q: accepted here, refused by the contract", p)
		}
	}
}

// describe runs the contract's queries against a migrated schema, with the
// schema's own name written as <schema> so two runs compare.
func describe(ctx context.Context, pool *pgxpool.Pool, schema string, queries map[string]string) (map[string][]string, error) {
	out := map[string][]string{}
	for name, q := range queries {
		rows, err := pool.Query(ctx, q, schema)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		lines := []string{}
		for rows.Next() {
			var line string
			if err := rows.Scan(&line); err != nil {
				rows.Close()
				return nil, err
			}
			lines = append(lines, strings.ReplaceAll(line, schema, "<schema>"))
		}
		rows.Close()
		out[name] = lines
	}
	return out, nil
}

func TestTheSchemaIsTheContracts(t *testing.T) {
	url := os.Getenv("DATAPLANE_PG_URL")
	if url == "" {
		if os.Getenv("DATAPLANE_REQUIRE_PG") == "1" {
			t.Fatal("DATAPLANE_REQUIRE_PG is set and DATAPLANE_PG_URL is not")
		}
		t.Skip("DATAPLANE_PG_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	schema := fmt.Sprintf("auditc_%d", time.Now().UnixNano())
	if err := Migrate(ctx, pool, schema); err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(ctx, fmt.Sprintf("DROP SCHEMA %s CASCADE", schema))
	c := readContract(t)
	got, err := describe(ctx, pool, schema, c.Queries)
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_AUDIT_CONTRACT") == "1" {
		c.Schema = got
		raw, _ := json.MarshalIndent(c, "", " ")
		if err := os.WriteFile(contractFile, append(raw, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	for name, want := range c.Schema {
		if strings.Join(got[name], "\n") != strings.Join(want, "\n") {
			t.Errorf("%s:\n got  %q\n want %q", name, got[name], want)
		}
	}
	if len(c.Schema) != len(c.Queries) {
		t.Errorf("the contract describes %d of its %d queries; regenerate it", len(c.Schema), len(c.Queries))
	}
}
