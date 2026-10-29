package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/access"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/ingest"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/server"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/stream"
)

// The loop end to end: a stand-in Stooq serving SYNTHETIC bars, a real data
// plane over HTTP on the memory store, and the load run twice with a
// correction at the source in between.
func TestLoadingTwiceAppendsOnlyWhatChangedAndNeverRewritesAMorning(t *testing.T) {
	var csv atomic.Value
	csv.Store("Date,Open,High,Low,Close,Volume\n2024-08-02,103.76,108.72,101.37,107.27,482027500\n2024-08-05,92.06,103.41,90.69,100.45,552842400\n")
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/q/d/l/" || r.URL.Query().Get("s") != "exmp.us" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(csv.Load().(string)))
	}))
	defer source.Close()

	store := pit.NewMemory()
	users := server.Users{
		"loader": {UserID: "loader", TenantID: "t", Vendors: map[string]bool{"stooq": true}},
		"pm":     {UserID: "pm", TenantID: "t", Vendors: map[string]bool{"stooq": true}},
		"intern": {UserID: "intern", TenantID: "t", Vendors: map[string]bool{}},
	}
	dp := httptest.NewServer((&server.Server{
		Reader: access.Reader{Store: store}, Hub: stream.NewHub(ingest.NewSymbology(), time.Second),
		Users: users, Writers: map[string]bool{"loader": true, "intern": true}, DevIdentity: true,
	}).Handler())
	defer dp.Close()

	load := func(as string) (string, error) {
		var stderr bytes.Buffer
		err := run(context.Background(), []string{"-to", dp.URL, "-as", as, "-source-base", source.URL, "stooq", "-symbol", "exmp.us", "-instrument", "EXMP"}, &bytes.Buffer{}, &stderr)
		return stderr.String(), err
	}
	morning := func() float64 {
		obs, err := store.AsOf(context.Background(), pit.Query{Key: "price:EXMP", KnowledgeTime: "2024-08-06T13:30:00Z"})
		if err != nil || len(obs) != 2 {
			t.Fatalf("%+v %v", obs, err)
		}
		return obs[1].Value
	}

	if msg, err := load("loader"); err != nil || !strings.Contains(msg, "10 facts from stooq; 0 already held; 10 to append") {
		t.Fatalf("%s %v", msg, err)
	}
	if msg, err := load("loader"); err != nil || !strings.Contains(msg, "10 already held; 0 to append") {
		t.Fatalf("the second load: %s %v", msg, err)
	}
	before := morning()

	csv.Store("Date,Open,High,Low,Close,Volume\n2024-08-02,103.76,108.72,101.37,107.27,482027500\n2024-08-05,92.06,103.41,90.69,100.5,552842400\n")
	if msg, err := load("loader"); err != nil || !strings.Contains(msg, "9 already held; 1 to append") {
		t.Fatalf("after a correction: %s %v", msg, err)
	}
	if after := morning(); after != before || after != 100.45 {
		t.Errorf("the morning of the 6th moved from %v to %v", before, after)
	}
	versions, _ := store.Versions(context.Background(), "price:EXMP", nil, nil)
	last := versions[len(versions)-1]
	if last.Value != 100.5 || !last.Restatement || last.KnowledgeTime <= "2024-08-06" || last.Class != entitle.Licensed || last.Vendor != "stooq" {
		t.Errorf("the correction: %+v", last)
	}

	// A writer who cannot see what is held cannot reconcile against it.
	if _, err := load("intern"); err == nil || !strings.Contains(err.Error(), "withheld from intern") {
		t.Errorf("a writer blind to the licensed versions: %v", err)
	}
}
