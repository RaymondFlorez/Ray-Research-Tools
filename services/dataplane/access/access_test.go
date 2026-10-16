package access

import (
	"context"
	"testing"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
)

func TestARestatedValueTheUserCannotSeeIsBlockedNotReplaced(t *testing.T) {
	ctx := context.Background()
	store := pit.NewMemory()
	// Q2 first from a public filing, then restated from a licensed vendor feed.
	_ = store.Append(ctx,
		pit.Fact{Key: "NVDA.revenue", ValidTime: "2024-06-30", KnowledgeTime: "2024-07-24", Value: 30.04, Class: entitle.Public},
		pit.Fact{Key: "NVDA.revenue", ValidTime: "2024-06-30", KnowledgeTime: "2025-02-26", Value: 29.87, Class: entitle.Licensed, Vendor: "vendor-b", Restatement: true},
		pit.Fact{Key: "NVDA.revenue", ValidTime: "2024-09-30", KnowledgeTime: "2024-11-20", Value: 35.08, Class: entitle.Public},
	)
	r := Reader{Store: store}
	analyst := entitle.Entitlements{UserID: "a", Vendors: map[string]bool{"vendor-a": true}}
	got, err := r.AsOf(ctx, analyst, pit.Query{Key: "NVDA.revenue", KnowledgeTime: "2026-01-01"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Observations) != 1 || got.Observations[0].ValidTime != "2024-09-30" {
		t.Fatalf("observations %+v", got.Observations)
	}
	// Not the 30.04 the analyst could see: that was superseded, and showing it
	// as current would be a stale number with no badge.
	if len(got.Blocked) != 1 || got.Blocked[0].ValidTime != "2024-06-30" || got.Blocked[0].Decision.Reason != "no_vendor_licence" {
		t.Fatalf("blocked %+v", got.Blocked)
	}
	// As of the morning before the restatement, the public value was current and is shown.
	before, _ := r.AsOf(ctx, analyst, pit.Query{Key: "NVDA.revenue", KnowledgeTime: "2024-08-05T09:30:00Z"})
	if len(before.Observations) != 1 || before.Observations[0].Value != 30.04 || len(before.Blocked) != 0 {
		t.Fatalf("before the restatement: %+v", before)
	}
	pm := entitle.Entitlements{UserID: "p", Vendors: map[string]bool{"vendor-b": true}}
	full, _ := r.AsOf(ctx, pm, pit.Query{Key: "NVDA.revenue", KnowledgeTime: "2026-01-01"})
	if len(full.Observations) != 2 || full.Observations[0].Value != 29.87 {
		t.Fatalf("licensed user: %+v", full)
	}
}
