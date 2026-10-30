package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/access"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/audit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/ingest"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/stream"
)

// PRD 7.2: every read of position data writes an audit record with actor,
// resource, purpose and trace id — before the data leaves, or not at all.
func TestAReadOfPositionsIsAuditedBeforeItIsServed(t *testing.T) {
	store := pit.NewMemory()
	_ = store.Append(context.Background(),
		pit.Fact{Key: "book.NVDA", ValidTime: "2024-08-02", KnowledgeTime: "2024-08-02", Value: 10_000, Class: entitle.Positions},
		pit.Fact{Key: "NVDA.revenue", ValidTime: "2024-06-30", KnowledgeTime: "2024-07-24", Value: 30.04, Class: entitle.Public},
	)
	trail := &audit.Memory{}
	s := &Server{
		Reader:      access.Reader{Store: store},
		Hub:         stream.NewHub(ingest.NewSymbology(), time.Second),
		Users:       Users{"pm": {UserID: "pm", TenantID: "dev", Positions: true, Vendors: map[string]bool{}}, "analyst": {UserID: "analyst", TenantID: "dev", Vendors: map[string]bool{}}},
		DevIdentity: true,
		Audit:       trail,
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	get := func(path, user string, headers map[string]string) (*http.Response, map[string]any) {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+path, nil)
		req.Header.Set(UserHeader, user)
		for k, v := range headers {
			req.Header.Set(k, v)
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
	book := "/v1/asof?key=book.NVDA&knowledge=2024-09-01"

	// No purpose: refused, and nothing served.
	if res, body := get(book, "pm", nil); res.StatusCode != http.StatusBadRequest || body["observations"] != nil {
		t.Errorf("no purpose: %d %v", res.StatusCode, body)
	}
	// A sentence is not a purpose: it is where content would leak into the trail.
	if res, body := get(book, "pm", map[string]string{audit.PurposeHeader: "check the pm's NVDA book"}); res.StatusCode != http.StatusBadRequest || body["observations"] != nil {
		t.Errorf("free-text purpose: %d %v", res.StatusCode, body)
	}
	// With a purpose and a trace: served, and the record says who, what, why and which trace.
	res, body := get(book, "pm", map[string]string{audit.PurposeHeader: "risk.rebalance", "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"})
	if res.StatusCode != http.StatusOK || len(body["observations"].([]any)) != 1 {
		t.Fatalf("with a purpose: %d %v", res.StatusCode, body)
	}
	if res.Header.Get(audit.TraceHeader) != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("trace header %q", res.Header.Get(audit.TraceHeader))
	}
	recs := trail.Records()
	if len(recs) != 1 || recs[0].Actor != "pm" || recs[0].Tenant != "dev" || recs[0].Resource != "book.NVDA" || recs[0].Purpose != "risk.rebalance" || recs[0].TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || recs[0].Action != "read:asof" {
		t.Errorf("record %+v", recs)
	}
	// Versions and history of the same fact are audited too.
	get("/v1/versions?key=book.NVDA", "pm", map[string]string{audit.PurposeHeader: "backtest"})
	get("/v1/history?key=book.NVDA&valid=2024-08-02", "pm", map[string]string{audit.PurposeHeader: "review.restatement"})
	if n := len(trail.Records()); n != 3 {
		t.Errorf("%d records after versions and history", n)
	}
	// A public read is not audited; a blocked one returns no positions, so neither.
	get("/v1/asof?key=NVDA.revenue&knowledge=2024-09-01", "pm", nil)
	if res, _ := get(book, "analyst", nil); res.StatusCode != http.StatusOK {
		t.Errorf("an unentitled read, which returns the position as blocked: %d", res.StatusCode)
	}
	if n := len(trail.Records()); n != 3 {
		t.Errorf("public and blocked reads were audited: %d records", n)
	}
	// The trail fails; the data is not served.
	trail.Fail = true
	if res, body := get(book, "pm", map[string]string{audit.PurposeHeader: "risk.rebalance"}); res.StatusCode != http.StatusServiceUnavailable || body["observations"] != nil {
		t.Errorf("a failing trail: %d %v", res.StatusCode, body)
	}
	// And with no trail configured at all, neither.
	s.Audit = nil
	if res, _ := get(book, "pm", map[string]string{audit.PurposeHeader: "risk.rebalance"}); res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("no trail: %d", res.StatusCode)
	}
}
