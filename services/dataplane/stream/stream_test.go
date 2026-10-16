package stream

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/ingest"
)

// A synthetic stream — not market data — at about 200 messages a second per
// instrument, with one duplicate, one gap and one unknown symbol in it.
func synthetic() []ingest.Raw {
	var out []ingest.Raw
	start := time.UnixMilli(1_700_000_000_000)
	seq := uint64(100)
	for ms := 0; ms < 5_000; ms += 5 {
		sym := []string{"NVDA", "AMD"}[(ms/5)%2]
		seq++
		if ms == 2_000 {
			seq += 3 // three messages lost
		}
		payload := fmt.Sprintf(`{"sym":%q,"t":%d,"f":{"price":%g,"size":%d}}`, sym, 1_700_000_000_000+ms, 100+float64(ms)/1000, 1+ms%7)
		if ms == 3_000 {
			payload = `{"sym":"NVDAX","t":1,"f":{"price":1}}`
		}
		r := ingest.Raw{Feed: "feed-a", Channel: "equities", Seq: seq, Payload: []byte(payload), ReceivedAt: start.Add(time.Duration(ms) * time.Millisecond)}
		out = append(out, r)
		if ms == 1_000 {
			out = append(out, r) // delivered twice
		}
	}
	return out
}

func symbology(t *testing.T) *ingest.Symbology {
	sym := ingest.NewSymbology()
	if err := sym.Map("feed-a", "NVDA", ingest.Instrument{ID: "NVDA", AssetClass: "equity", Class: entitle.Public}); err != nil {
		t.Fatal(err)
	}
	if err := sym.Map("feed-a", "AMD", ingest.Instrument{ID: "AMD", AssetClass: "equity", Class: entitle.Licensed, Vendor: "vendor-b"}); err != nil {
		t.Fatal(err)
	}
	return sym
}

func TestTheHubConflatesFiltersAndCounts(t *testing.T) {
	hub := NewHub(symbology(t), 2*time.Second)
	analyst := hub.Subscribe([]string{"tick.equity.*"}, entitle.Entitlements{UserID: "analyst", Vendors: map[string]bool{"vendor-a": true}})
	pm := hub.Subscribe([]string{"tick.equity.>"}, entitle.Entitlements{UserID: "pm", Vendors: map[string]bool{"vendor-b": true}})
	other := hub.Subscribe([]string{"tick.crypto.*"}, entitle.Entitlements{UserID: "c"})
	defer analyst.Close()
	defer pm.Close()
	defer other.Close()

	perSecond := map[string]map[int]int{}
	got := map[string]int{}
	msgs := synthetic()
	start := float64(msgs[0].ReceivedAt.UnixMilli())
	next := 0
	// Drain every 50ms of simulated time, as the server's timer would.
	for now := start; now <= start+5_500; now += 50 {
		for next < len(msgs) && float64(msgs[next].ReceivedAt.UnixMilli()) <= now {
			hub.Ingest(msgs[next])
			next++
		}
		for name, s := range map[string]*Subscription{"analyst": analyst, "pm": pm, "other": other} {
			for _, u := range s.Drain(now) {
				key := name + "/" + u.SeriesID
				got[key]++
				if perSecond[key] == nil {
					perSecond[key] = map[int]int{}
				}
				perSecond[key][int((now-start)/1000)]++
			}
		}
	}

	if got["analyst/AMD"] != 0 || got["other/NVDA"] != 0 {
		t.Fatalf("delivered where it should not be: %v", got)
	}
	if d, ok := analyst.Blocked()["AMD"]; !ok || d.Reason != "no_vendor_licence" {
		t.Fatalf("the analyst was not told AMD is blocked: %+v", analyst.Blocked())
	}
	if got["analyst/NVDA"] < 15 || got["pm/AMD"] < 15 || got["pm/NVDA"] < 15 {
		t.Fatalf("too few updates: %v", got)
	}
	for key, seconds := range perSecond {
		for s, n := range seconds {
			if n > 4 {
				t.Fatalf("%s sent %d updates in second %d; the cap is 4", key, n, s)
			}
		}
	}
	c := hub.Counts()
	if c.Duplicates != 1 || len(c.Rejections) != 1 || len(c.Gaps) != 1 || c.Gaps[0].To-c.Gaps[0].From != 2 {
		t.Fatalf("counts %+v", c)
	}
	if c.Rejections[0].Reason != "unknown symbol NVDAX" {
		t.Fatalf("rejection %+v", c.Rejections[0])
	}
	// The gap leaves the channel recovering until a snapshot says otherwise.
	health := pm.Health(start + 5_000)
	if len(health) != 2 || health[0].State != ingest.Recovering {
		t.Fatalf("health %+v", health)
	}
	hub.Recovered("equities")
	if h := pm.Health(start + 5_000); h[0].State != ingest.Live {
		t.Fatalf("after recovery %+v", h)
	}
	// Silence makes it stale, with the time since the last update.
	if h := pm.Health(start + 9_000); h[0].State != ingest.Stale || h[0].ElapsedMs < 4_000 {
		t.Fatalf("after silence %+v", h)
	}
}

func TestReplayReadsARecordingInOrder(t *testing.T) {
	var buf bytes.Buffer
	for i, sym := range []string{"NVDA", "AMD", "NVDA"} {
		line, _ := json.Marshal(Recorded{Feed: "feed-a", Channel: "equities", Seq: uint64(i + 1), OffsetMs: float64(i * 100), Payload: json.RawMessage(fmt.Sprintf(`{"sym":%q,"t":%d,"f":{"price":1}}`, sym, i))})
		buf.Write(append(line, '\n'))
	}
	hub := NewHub(symbology(t), time.Second)
	if err := hub.Run(context.Background(), Replay{Source: &buf}); err != nil {
		t.Fatal(err)
	}
	if c := hub.Counts(); c.Accepted != 3 || c.Duplicates != 0 || len(c.Gaps) != 0 {
		t.Fatalf("%+v", c)
	}
}
