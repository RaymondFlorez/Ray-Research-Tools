package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/access"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/ingest"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/stream"
)

func fixture(t *testing.T) (*httptest.Server, *stream.Hub) {
	t.Helper()
	store := pit.NewMemory()
	_ = store.Append(context.Background(),
		pit.Fact{Key: "NVDA.revenue", ValidTime: "2024-06-30", KnowledgeTime: "2024-07-24", Value: 30.04, Class: entitle.Public},
		pit.Fact{Key: "NVDA.revenue", ValidTime: "2024-06-30", KnowledgeTime: "2025-02-26", Value: 29.87, Class: entitle.Licensed, Vendor: "vendor-b"},
	)
	sym := ingest.NewSymbology()
	_ = sym.Map("feed-a", "NVDA", ingest.Instrument{ID: "NVDA", AssetClass: "equity", Class: entitle.Public})
	_ = sym.Map("feed-a", "AMD", ingest.Instrument{ID: "AMD", AssetClass: "equity", Class: entitle.Licensed, Vendor: "vendor-b"})
	hub := stream.NewHub(sym, 300*time.Millisecond)
	s := &Server{
		Reader: access.Reader{Store: store},
		Hub:    hub,
		Users: Users{
			"analyst": {UserID: "analyst", Vendors: map[string]bool{}},
			"pm":      {UserID: "pm", Vendors: map[string]bool{"vendor-b": true}},
		},
		DrainEvery:  20 * time.Millisecond,
		HealthEvery: 100 * time.Millisecond,
	}
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return ts, hub
}

func get(t *testing.T, url, user string) (*http.Response, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, url, nil)
	if user != "" {
		req.Header.Set(UserHeader, user)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(res.Body).Decode(&body)
	return res, body
}

func TestReadsAreRefusedWithoutAUserOrAKnowledgeTime(t *testing.T) {
	ts, _ := fixture(t)
	if res, _ := get(t, ts.URL+"/v1/asof?key=NVDA.revenue&knowledge=2026-01-01", ""); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no user: %d", res.StatusCode)
	}
	if res, _ := get(t, ts.URL+"/v1/asof?key=NVDA.revenue", "pm"); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("no knowledge time: %d", res.StatusCode)
	}
	_, body := get(t, ts.URL+"/v1/asof?key=NVDA.revenue&knowledge=2026-01-01", "analyst")
	if len(body["observations"].([]any)) != 0 || len(body["blocked"].([]any)) != 1 {
		t.Fatalf("analyst: %v", body)
	}
	_, body = get(t, ts.URL+"/v1/asof?key=NVDA.revenue&knowledge=2026-01-01", "pm")
	if obs := body["observations"].([]any); len(obs) != 1 || obs[0].(map[string]any)["value"].(float64) != 29.87 {
		t.Fatalf("pm: %v", body)
	}
}

type sse struct{ event, data string }

func TestTheStreamDeliversEntitledUpdatesBlockedNoticesAndHealth(t *testing.T) {
	ts, hub := fixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/v1/stream?subject=tick.equity.*", nil)
	req.Header.Set(UserHeader, "analyst")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content type %q", res.Header.Get("Content-Type"))
	}
	events := make(chan sse, 256)
	go func() {
		scan := bufio.NewScanner(res.Body)
		var ev sse
		for scan.Scan() {
			line := scan.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				ev.event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.data = strings.TrimPrefix(line, "data: ")
			case line == "":
				events <- ev
				ev = sse{}
			}
		}
		close(events)
	}()
	// A synthetic feed — not market data — for half a second, then silence.
	go func() {
		seq := uint64(0)
		for i := 0; i < 100; i++ {
			for _, sym := range []string{"NVDA", "AMD"} {
				seq++
				hub.Ingest(ingest.Raw{Feed: "feed-a", Channel: "eq", Seq: seq, ReceivedAt: time.Now(),
					Payload: []byte(fmt.Sprintf(`{"sym":%q,"t":%d,"f":{"price":%d,"size":1}}`, sym, time.Now().UnixMilli(), 100+i))})
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	var updates, blocked, staleHealth int
	deadline := time.After(2500 * time.Millisecond)
loop:
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				break loop
			}
			switch ev.event {
			case "update":
				if strings.Contains(ev.data, `"AMD"`) {
					t.Fatalf("an unlicensed user received AMD: %s", ev.data)
				}
				updates++
			case "blocked":
				if !strings.Contains(ev.data, `"AMD"`) || !strings.Contains(ev.data, "no_vendor_licence") {
					t.Fatalf("blocked: %s", ev.data)
				}
				blocked++
			case "health":
				if strings.Contains(ev.data, `"state":"stale"`) && strings.Contains(ev.data, `"elapsedMs"`) {
					staleHealth++
				}
			}
		case <-deadline:
			break loop
		}
	}
	// Half a second at 4Hz is two or three updates; never more than the cap allows.
	if updates < 2 || updates > 4 {
		t.Fatalf("%d NVDA updates in ~0.5s of feed", updates)
	}
	if blocked != 1 {
		t.Fatalf("blocked notices: %d, want exactly one", blocked)
	}
	if staleHealth == 0 {
		t.Fatal("the feed went silent and no stale health event arrived")
	}
}
