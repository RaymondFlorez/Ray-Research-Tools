package pit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/internal/contract"
)

// postgres returns a pool on a fresh schema, or skips — unless the run says a
// database is required, as CI does, in which case its absence is a failure.
func postgres(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	url := os.Getenv("DATAPLANE_PG_URL")
	if url == "" {
		if os.Getenv("DATAPLANE_REQUIRE_PG") == "1" {
			t.Fatal("DATAPLANE_REQUIRE_PG is set and DATAPLANE_PG_URL is not")
		}
		t.Skip("no DATAPLANE_PG_URL; the Postgres store is not exercised in this run")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	schema := "t_" + hex.EncodeToString(b)
	if err := Migrate(ctx, pool, schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		pool.Close()
	})
	return pool, schema
}

func stores(t *testing.T) map[string]Store {
	out := map[string]Store{"memory": NewMemory()}
	if os.Getenv("DATAPLANE_PG_URL") != "" || os.Getenv("DATAPLANE_REQUIRE_PG") == "1" {
		pool, schema := postgres(t)
		pg, err := NewPostgres(pool, schema)
		if err != nil {
			t.Fatal(err)
		}
		out["postgres"] = pg
	}
	return out
}

func TestBothStoresAnswerAsTheTypeScriptDoes(t *testing.T) {
	f, err := contract.Load()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for name, store := range stores(t) {
		facts := make([]Fact, len(f.PointInTime.Facts))
		for i, c := range f.PointInTime.Facts {
			facts[i] = Fact{Key: c.Key, ValidTime: c.ValidTime, KnowledgeTime: c.KnowledgeTime, Value: c.Value, Source: c.Source, Restatement: c.Restatement, Class: entitle.Public}
		}
		if err := store.Append(ctx, facts...); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		nonEmpty := 0
		for _, c := range f.PointInTime.AsOf {
			got, err := store.AsOf(ctx, Query{Key: c.Query.Key, KnowledgeTime: c.Query.KnowledgeTime, From: c.Query.From, To: c.Query.To})
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if len(got) != len(c.Expected) {
				t.Fatalf("%s %+v: %d observations, want %d", name, c.Query, len(got), len(c.Expected))
			}
			for i, w := range c.Expected {
				g := got[i]
				if g.ValidTime != w.ValidTime || g.Value != w.Value || g.KnownAt != w.KnownAt || g.Source != w.Source {
					t.Fatalf("%s %+v [%d]: got %+v, want %+v", name, c.Query, i, g, w)
				}
			}
			if len(got) > 0 {
				nonEmpty++
			}
		}
		if nonEmpty < 20 {
			t.Fatalf("%s: only %d non-empty reads; the contract is not exercising much", name, nonEmpty)
		}
		for _, c := range f.PointInTime.Versions {
			got, err := store.Versions(ctx, c.Key, c.From, c.To)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(c.Expected) {
				t.Fatalf("%s versions %s: %d, want %d", name, c.Key, len(got), len(c.Expected))
			}
			for i, w := range c.Expected {
				g := got[i]
				if g.ValidTime != w.ValidTime || g.KnowledgeTime != w.KnowledgeTime || g.Value != w.Value || g.Restatement != w.Restatement || g.Source != w.Source {
					t.Fatalf("%s versions %s [%d]: got %+v, want %+v", name, c.Key, i, g, w)
				}
			}
		}
		for _, c := range f.PointInTime.History {
			got, err := store.History(ctx, c.Key, c.ValidTime)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != len(c.Expected) {
				t.Fatalf("%s history %s/%s: %d versions, want %d", name, c.Key, c.ValidTime, len(got), len(c.Expected))
			}
			for i, w := range c.Expected {
				if got[i].KnowledgeTime != w.KnowledgeTime || got[i].Value != w.Value || got[i].Restatement != w.Restatement {
					t.Fatalf("%s history %s/%s [%d]: got %+v, want %+v", name, c.Key, c.ValidTime, i, got[i], w)
				}
			}
		}
	}
}

func TestAFactWithNoClassIsRefused(t *testing.T) {
	ctx := context.Background()
	for name, store := range stores(t) {
		for _, f := range []Fact{
			{Key: "k", ValidTime: "2024-01-01", KnowledgeTime: "2024-01-02", Value: 1},
			{Key: "k", ValidTime: "2024-01-01", KnowledgeTime: "2024-01-02", Value: 1, Class: entitle.Licensed},
		} {
			var unclassified ErrUnclassified
			if err := store.Append(ctx, f); !errors.As(err, &unclassified) {
				t.Fatalf("%s: appended %+v: %v", name, f, err)
			}
		}
	}
}

// The database refuses to rewrite history, whoever asks.
func TestTheDatabaseRefusesEveryRewrite(t *testing.T) {
	pool, schema := postgres(t)
	ctx := context.Background()
	pg, _ := NewPostgres(pool, schema)
	if err := pg.Append(ctx, Fact{Key: "k", ValidTime: "2024-01-01", KnowledgeTime: "2024-01-02", Value: 1, Class: entitle.Public}); err != nil {
		t.Fatal(err)
	}
	for _, stmt := range []string{
		"UPDATE " + schema + ".facts SET value = 2",
		"DELETE FROM " + schema + ".facts",
		"TRUNCATE " + schema + ".facts",
	} {
		_, err := pool.Exec(ctx, stmt)
		if err == nil || !strings.Contains(err.Error(), "append-only") {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	// And the service role could not even if the triggers were gone.
	role := schema + "_svc"
	if _, err := pool.Exec(ctx, "CREATE ROLE "+role); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DROP OWNED BY "+role)
		_, _ = pool.Exec(context.Background(), "DROP ROLE "+role)
	})
	if err := GrantService(ctx, pool, schema, role); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DROP TRIGGER facts_no_rewrite ON "+schema+".facts"); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SET LOCAL ROLE "+role); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, "SELECT count(*) FROM "+schema+".facts"); err != nil {
		t.Fatalf("the service role cannot read: %v", err)
	}
	if _, err := tx.Exec(ctx, "DELETE FROM "+schema+".facts"); err == nil || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("the service role deleted, or failed for the wrong reason: %v", err)
	}
}
