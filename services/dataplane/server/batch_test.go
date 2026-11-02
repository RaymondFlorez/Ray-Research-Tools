package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strconv"
	"testing"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/access"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/audit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/ingest"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/stream"
)

// A batched read answers each key exactly as the single read does, for every
// caller, at every knowledge time; and keeps the single read's audit rule.
func TestABatchIsTheSingleReadsInOneRequest(t *testing.T) {
	store := pit.NewMemory()
	_ = store.Append(context.Background(),
		pit.Fact{Key: "NVDA.revenue", ValidTime: "2024-06-30", KnowledgeTime: "2024-07-24", Value: 30.04, Class: entitle.Public},
		pit.Fact{Key: "NVDA.revenue", ValidTime: "2024-06-30", KnowledgeTime: "2025-02-26", Value: 29.87, Class: entitle.Licensed, Vendor: "vendor-b"},
		pit.Fact{Key: "NVDA.revenue", ValidTime: "2024-09-30", KnowledgeTime: "2024-11-20", Value: 35.08, Class: entitle.Public},
		pit.Fact{Key: "AMD.revenue", ValidTime: "2024-06-30", KnowledgeTime: "2024-07-30", Value: 5.84, Class: entitle.Public},
		pit.Fact{Key: "book.NVDA", ValidTime: "2024-08-02", KnowledgeTime: "2024-08-02", Value: 10_000, Class: entitle.Positions},
	)
	trail := &audit.Memory{}
	s := &Server{
		Reader: access.Reader{Store: store},
		Hub:    stream.NewHub(ingest.NewSymbology(), time.Second),
		Users: Users{
			"pm":      {UserID: "pm", TenantID: "dev", Positions: true, Vendors: map[string]bool{"vendor-b": true}},
			"analyst": {UserID: "analyst", TenantID: "dev", Vendors: map[string]bool{}},
		},
		DevIdentity: true,
		Audit:       trail,
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	do := func(req *http.Request, user string, purpose string) (int, []byte) {
		req.Header.Set(UserHeader, user)
		if purpose != "" {
			req.Header.Set(audit.PurposeHeader, purpose)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(res.Body)
		return res.StatusCode, buf.Bytes()
	}
	batch := func(user, knowledge, purpose string, keys ...string) (int, map[string]any) {
		body, _ := json.Marshal(map[string]any{"knowledge": knowledge, "keys": keys})
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/asof/batch", bytes.NewReader(body))
		code, raw := do(req, user, purpose)
		var out map[string]any
		_ = json.Unmarshal(raw, &out)
		return code, out
	}
	single := func(user, knowledge, key string) any {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/asof?key="+url.QueryEscape(key)+"&knowledge="+url.QueryEscape(knowledge), nil)
		_, raw := do(req, user, "")
		var out any
		_ = json.Unmarshal(raw, &out)
		return out
	}

	keys := []string{"NVDA.revenue", "AMD.revenue", "MSFT.revenue"}
	for _, user := range []string{"pm", "analyst"} {
		for _, k := range []string{"2024-08-05", "2025-03-01"} {
			code, got := batch(user, k, "", append(keys, "NVDA.revenue")...)
			if code != 200 {
				t.Fatalf("%s at %s: %d %v", user, k, code, got)
			}
			results := got["results"].(map[string]any)
			if len(results) != len(keys) {
				t.Errorf("%s at %s: %d results for %d distinct keys", user, k, len(results), len(keys))
			}
			for _, key := range keys {
				if want := single(user, k, key); !reflect.DeepEqual(results[key], want) {
					t.Errorf("%s at %s, %s: batch %v, single %v", user, k, key, results[key], want)
				}
			}
		}
	}

	// Position data in a batch: no purpose, nothing served; with one, a record per sensitive key.
	if code, body := batch("pm", "2024-09-01", "", "NVDA.revenue", "book.NVDA"); code != http.StatusBadRequest || body["results"] != nil {
		t.Errorf("positions in a batch with no purpose: %d %v", code, body)
	}
	if code, _ := batch("pm", "2024-09-01", "risk.rebalance", "NVDA.revenue", "book.NVDA"); code != 200 {
		t.Errorf("with a purpose: %d", code)
	}
	if recs := trail.Records(); len(recs) != 1 || recs[0].Resource != "book.NVDA" || recs[0].Purpose != "risk.rebalance" {
		t.Errorf("trail: %+v, want one record, for book.NVDA", recs)
	}
	// The analyst gets the position blocked: nothing served, nothing recorded.
	if code, _ := batch("analyst", "2024-09-01", "", "book.NVDA"); code != 200 || len(trail.Records()) != 1 {
		t.Errorf("a blocked position in a batch: %d, %d records", code, len(trail.Records()))
	}

	if code, _ := batch("pm", "", "", "NVDA.revenue"); code != http.StatusBadRequest {
		t.Errorf("no knowledge time: %d", code)
	}
	many := make([]string, MaxBatchKeys+1)
	for i := range many {
		many[i] = fmt.Sprintf("K%d.revenue", i)
	}
	if code, _ := batch("pm", "2024-09-01", "", many...); code != http.StatusBadRequest {
		t.Errorf("%d keys: %d, want the limit refused", len(many), code)
	}
}

// canvas-data's client splits a batch at its own copy of the limit; the two must agree.
func TestTheClientsBatchLimitIsThisOne(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/canvas-data/src/remote.ts")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`export const MAX_BATCH_KEYS = (\d+);`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("MAX_BATCH_KEYS not found in canvas-data's remote.ts")
	}
	if n, _ := strconv.Atoi(string(m[1])); n != MaxBatchKeys {
		t.Errorf("canvas-data splits batches at %d; the data plane allows %d", n, MaxBatchKeys)
	}
}
