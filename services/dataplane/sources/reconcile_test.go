package sources

import (
	"context"
	"testing"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
)

func fact(valid, known string, v float64) pit.Fact {
	return pit.Fact{Key: "price:EXMP", ValidTime: valid, KnowledgeTime: known, Value: v, Source: "Stooq daily", Class: entitle.Licensed, Vendor: "stooq"}
}

func TestReloadingNeverRewritesThePast(t *testing.T) {
	first := []pit.Fact{fact("2024-08-02", "2024-08-02T21:00:00Z", 107.27), fact("2024-08-05", "2024-08-05T21:00:00Z", 100.45)}
	store := pit.NewMemory()
	ctx := context.Background()
	if err := store.Append(ctx, Reconcile(nil, first, "2024-08-06T00:00:00Z")...); err != nil {
		t.Fatal(err)
	}
	morning := func() []pit.Observation {
		obs, _ := store.AsOf(ctx, pit.Query{Key: "price:EXMP", KnowledgeTime: "2024-08-06T13:30:00Z"})
		return obs
	}
	before := morning()

	// The same file again: nothing to append.
	if again := Reconcile(first, first, "2024-09-01T00:00:00Z"); len(again) != 0 {
		t.Errorf("a reload appended %+v", again)
	}

	// The source has since corrected the 5th, and added the 6th.
	reload := []pit.Fact{fact("2024-08-02", "2024-08-02T21:00:00Z", 107.27), fact("2024-08-05", "2024-08-05T21:00:00Z", 100.5), fact("2024-08-06", "2024-08-06T21:00:00Z", 98.91)}
	appended := Reconcile(first, reload, "2024-09-01T12:00:00Z")
	if len(appended) != 2 {
		t.Fatalf("appended %+v", appended)
	}
	if c := appended[0]; c.ValidTime != "2024-08-05" || c.KnowledgeTime != "2024-09-01T12:00:00Z" || !c.Restatement || c.Value != 100.5 {
		t.Errorf("the correction: %+v", c)
	}
	if n := appended[1]; n.ValidTime != "2024-08-06" || n.KnowledgeTime != "2024-08-06T21:00:00Z" || n.Restatement {
		t.Errorf("the new bar: %+v", n)
	}
	if err := store.Append(ctx, appended...); err != nil {
		t.Fatal(err)
	}
	after := morning()
	if len(after) != len(before) || after[1].Value != before[1].Value || after[1].Value != 100.45 {
		t.Errorf("the morning of the 6th changed: %+v, was %+v", after, before)
	}
	today, _ := store.AsOf(ctx, pit.Query{Key: "price:EXMP", KnowledgeTime: "2024-09-02T00:00:00Z"})
	if today[1].Value != 100.5 {
		t.Errorf("the correction is not visible after it was found: %+v", today)
	}
}

func TestReloadingASourceWithVintagesAddsOnlyNewVintages(t *testing.T) {
	held := []pit.Fact{fact("2024-04-01", "2024-07-26T05:00:00Z", 100)}
	incoming := []pit.Fact{fact("2024-04-01", "2024-07-26T05:00:00Z", 100), fact("2024-04-01", "2024-08-30T05:00:00Z", 100.5)}
	incoming[1].Restatement = true
	got := Reconcile(held, incoming, "2025-01-01T00:00:00Z")
	if len(got) != 1 || got[0].KnowledgeTime != "2024-08-30T05:00:00Z" || got[0].Value != 100.5 {
		t.Errorf("%+v", got)
	}
}
