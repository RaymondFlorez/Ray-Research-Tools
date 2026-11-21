package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/raymondflorez/ray-research-tools/services/gateway/audit"
)

// PRD 7.2: every AI dispatch writes an append-only record with actor,
// resource, purpose and trace ID, and the record comes first.
func TestEveryDispatchIsOnTheTrailBeforeTheProviderIsCalled(t *testing.T) {
	up := newUpstream(t)
	trail := &audit.Memory{}
	_, srv := gateway(t, []Provider{{ID: "vllm", Name: "vLLM", Kind: "openai", BaseURL: up.srv.URL + "/v1", Placement: SelfHosted, Auth: AuthNone}},
		func(s *Server) { s.trail = trail })

	post := func(body map[string]any, traceparent string) *http.Response {
		raw, _ := json.Marshal(body)
		req, _ := http.NewRequest("POST", srv.URL+"/v1/chat", bytes.NewReader(raw))
		req.Header.Set("X-Picasso-User", "pm")
		if traceparent != "" {
			req.Header.Set("traceparent", traceparent)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res
	}

	noPurpose := chatBody("vllm", "positions")
	delete(noPurpose, "purpose")
	if res := post(noPurpose, ""); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("a dispatch with no purpose: %d, want 400", res.StatusCode)
	}
	sentence := chatBody("vllm", "positions")
	sentence["purpose"] = "count the rows in the pm's book"
	if res := post(sentence, ""); res.StatusCode != http.StatusBadRequest {
		t.Fatalf("a dispatch whose purpose is a sentence: %d, want 400", res.StatusCode)
	}
	if len(up.calls) != 0 || len(trail.Records()) != 0 {
		t.Fatal("a dispatch with no purpose, or a sentence for one, reached the provider or the trail")
	}

	const trace = "4bf92f3577b34da6a3ce929d0e0e4736"
	res := post(chatBody("vllm", "positions"), "00-"+trace+"-00f067aa0ba902b7-01")
	if res.StatusCode != 200 {
		t.Fatalf("dispatch: %d", res.StatusCode)
	}
	if got := res.Header.Get(audit.TraceHeader); got != trace {
		t.Errorf("trace header %q, want the caller's %q", got, trace)
	}
	recs := trail.Records()
	if len(recs) != 2 {
		t.Fatalf("records: %+v, want the dispatch and its outcome", recs)
	}
	sent, done := recs[0], recs[1]
	if sent.Actor != "pm" || sent.Action != "ai_dispatch" || sent.Resource != "vllm/qwen-coder-32b" || sent.Purpose != "sql.generate" || sent.TraceID != trace || sent.Outcome != "sent: positions" {
		t.Errorf("dispatch record: %+v", sent)
	}
	if done.TraceID != trace || done.Outcome != "returned: end, 30 in, 3 out" {
		t.Errorf("outcome record: %+v", done)
	}
	for _, r := range recs {
		raw, _ := json.Marshal(r)
		if strings.Contains(string(raw), "count the rows") || strings.Contains(string(raw), "SELECT 1") {
			t.Error("the trail holds message content")
		}
	}

	// Fail closed: no record, no call.
	calls := len(up.calls)
	trail.Fail = true
	if res := post(chatBody("vllm", "public"), ""); res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("with the trail down: %d, want 503", res.StatusCode)
	}
	if len(up.calls) != calls {
		t.Error("the provider was called with no audit record written")
	}
}

func TestNoTrailMeansNoDispatch(t *testing.T) {
	up := newUpstream(t)
	_, srv := gateway(t, []Provider{{ID: "vllm", Name: "vLLM", Kind: "openai", BaseURL: up.srv.URL + "/v1", Placement: SelfHosted, Auth: AuthNone}},
		func(s *Server) { s.trail = nil })
	if code, _ := call(t, srv, "POST", "/v1/chat", "pm", chatBody("vllm", "public")); code != http.StatusServiceUnavailable {
		t.Errorf("no trail configured: %d, want 503", code)
	}
	if len(up.calls) != 0 {
		t.Error("dispatched with no trail")
	}
}

// A pinned dispatch: refused for Claude, which takes no temperature or seed,
// before anything is written or sent; carried to a Chat Completions server,
// and on the trail with its seed.
func TestAPinnedDispatchIsPinnedOrRefused(t *testing.T) {
	claude, local := newUpstream(t), newUpstream(t)
	trail := &audit.Memory{}
	_, srv := gateway(t, []Provider{
		{ID: "anthropic", Name: "Anthropic", Kind: "anthropic", BaseURL: claude.srv.URL, Placement: Vendor, Auth: AuthAPIKey},
		{ID: "vllm", Name: "vLLM", Kind: "openai", BaseURL: local.srv.URL + "/v1", Placement: SelfHosted, Auth: AuthNone},
	}, func(s *Server) { s.trail = trail })
	_, _ = call(t, srv, "PUT", "/v1/accounts/anthropic", "pm", map[string]string{"apiKey": "sk-ant-abcdefgh"})

	body := chatBody("anthropic", "public")
	body["pinned"] = map[string]any{"seed": 7}
	if code, out := call(t, srv, "POST", "/v1/chat", "pm", body); code != http.StatusUnprocessableEntity || !strings.Contains(out["error"].(string), "cannot serve a pinned dispatch") {
		t.Errorf("pinned to Claude: %d %v", code, out)
	}
	if len(claude.calls) != 0 || len(trail.Records()) != 0 {
		t.Fatalf("a pinned dispatch Claude cannot serve reached it (%d) or the trail (%d)", len(claude.calls), len(trail.Records()))
	}

	body = chatBody("vllm", "positions")
	body["pinned"] = map[string]any{"seed": 7}
	if code, out := call(t, srv, "POST", "/v1/chat", "pm", body); code != 200 {
		t.Fatalf("pinned to vLLM: %d %v", code, out)
	}
	var sent map[string]any
	_ = json.Unmarshal([]byte(local.calls[0].body), &sent)
	if sent["temperature"] != float64(0) || sent["seed"] != float64(7) {
		t.Errorf("vLLM received %v", sent)
	}
	if recs := trail.Records(); len(recs) != 2 || recs[0].Outcome != "sent: positions, pinned at temperature 0, seed 7" {
		t.Errorf("trail: %+v", recs)
	}

	_, listing := call(t, srv, "GET", "/v1/providers", "pm", nil)
	pins := map[string]any{}
	for _, p := range listing["providers"].([]any) {
		pins[p.(map[string]any)["id"].(string)] = p.(map[string]any)["pins"]
	}
	if pins["anthropic"] != false || pins["vllm"] != true {
		t.Errorf("the listing says %v", pins)
	}
}
