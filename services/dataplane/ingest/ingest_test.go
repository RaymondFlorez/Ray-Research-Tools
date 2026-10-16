package ingest

import (
	"fmt"
	"testing"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
)

func TestSubjectsMatchAsNATSDoes(t *testing.T) {
	cases := []struct {
		pattern, subject string
		want             bool
	}{
		{"tick.equity.NVDA", "tick.equity.NVDA", true},
		{"tick.equity.*", "tick.equity.NVDA", true},
		{"tick.*.NVDA", "tick.equity.NVDA", true},
		{"tick.>", "tick.equity.NVDA", true},
		{"tick.equity.>", "tick.equity", false}, // > needs at least one token
		{"tick.equity.*", "tick.equity.NVDA.extra", false},
		{"tick.equity", "tick.equity.NVDA", false},
		{"tick.crypto.*", "tick.equity.NVDA", false},
	}
	for _, c := range cases {
		if got := Match(c.pattern, c.subject); got != c.want {
			t.Errorf("Match(%q, %q) = %v", c.pattern, c.subject, got)
		}
	}
}

func TestPartitionsAreStableAndSpread(t *testing.T) {
	counts := make([]int, 12)
	for i := 0; i < 1200; i++ {
		id := fmt.Sprintf("SYM%04d", i)
		p := Partition(id, 12)
		if p != Partition(id, 12) || p < 0 || p >= 12 {
			t.Fatalf("partition of %s unstable or out of range: %d", id, p)
		}
		counts[p]++
	}
	for p, n := range counts {
		// 100 expected per partition; FNV-1a lands within half of it.
		if n < 50 || n > 150 {
			t.Fatalf("partition %d holds %d of 1,200: %v", p, n, counts)
		}
	}
}

func TestUnknownSymbolsAreRefusedNotGuessed(t *testing.T) {
	sym := NewSymbology()
	if err := sym.Map("feed-a", "NVDA", Instrument{ID: "NVDA", AssetClass: "equity", Class: entitle.Public}); err != nil {
		t.Fatal(err)
	}
	if err := sym.Map("feed-a", "AMD", Instrument{ID: "AMD", AssetClass: "equity", Class: entitle.Licensed}); err == nil {
		t.Fatal("a licensed instrument with no vendor was mapped")
	}
	at := time.UnixMilli(1_700_000_000_000)
	if _, rej := Decode(sym, Raw{Feed: "feed-a", Payload: []byte(`{"sym":"NVDA","t":1,"f":{"price":120}}`), ReceivedAt: at}); rej != nil {
		t.Fatal(rej.Reason)
	}
	for payload, reason := range map[string]string{
		`{"sym":"NVDAX","t":1,"f":{"price":120}}`: "unknown symbol NVDAX",
		`{"sym":"NVDA","t":1,"f":{}}`:             "no fields",
		`{"sym":`:                                 "malformed",
	} {
		_, rej := Decode(sym, Raw{Feed: "feed-a", Payload: []byte(payload), ReceivedAt: at})
		if rej == nil || len(rej.Reason) < len(reason) || rej.Reason[:len(reason)] != reason {
			t.Fatalf("%s: %+v", payload, rej)
		}
	}
	// The same symbol on another feed is not known either: symbology is per feed.
	if _, rej := Decode(sym, Raw{Feed: "feed-b", Payload: []byte(`{"sym":"NVDA","t":1,"f":{"price":1}}`), ReceivedAt: at}); rej == nil {
		t.Fatal("feed-b's NVDA resolved through feed-a's symbology")
	}
}

func TestTheSequencerReportsGapsOnceAndDropsDuplicates(t *testing.T) {
	s := NewSequencer()
	steps := []struct {
		seq  uint64
		want Verdict
	}{{10, InOrder}, {11, InOrder}, {11, Duplicate}, {15, Gap}, {14, Duplicate}, {16, InOrder}}
	for _, st := range steps {
		v, g := s.Observe("f", "c", st.seq)
		if v != st.want {
			t.Fatalf("seq %d: %v, want %v", st.seq, v, st.want)
		}
		if v == Gap && (g.From != 12 || g.To != 14) {
			t.Fatalf("gap %+v", g)
		}
	}
	// Channels are independent.
	if v, _ := s.Observe("f", "other", 3); v != InOrder {
		t.Fatal("a new channel inherited another's sequence")
	}
}

func TestHealthIsLiveStaleOrRecoveringWithElapsedTime(t *testing.T) {
	m := NewMonitor(2 * time.Second)
	if h := m.Check("NVDA", 0); h.State != Stale {
		t.Fatalf("never seen: %+v", h)
	}
	m.Seen("NVDA", "c1", 1_000)
	if h := m.Check("NVDA", 2_500); h.State != Live || h.ElapsedMs != 1_500 {
		t.Fatalf("%+v", h)
	}
	if h := m.Check("NVDA", 3_500); h.State != Stale || h.ElapsedMs != 2_500 || h.LastUpdate != 1_000 {
		t.Fatalf("%+v", h)
	}
	m.Seen("NVDA", "c1", 4_000)
	m.GapOn("c1", GapRange{Channel: "c1", From: 7, To: 9})
	if h := m.Check("NVDA", 4_100); h.State != Recovering || h.Reason != "sequence gap 7-9 on c1" {
		t.Fatalf("%+v", h)
	}
	m.Recovered("c1")
	if h := m.Check("NVDA", 4_100); h.State != Live {
		t.Fatalf("%+v", h)
	}
}
