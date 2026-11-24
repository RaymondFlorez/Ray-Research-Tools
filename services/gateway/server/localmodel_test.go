package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/raymondflorez/ray-research-tools/services/gateway/audit"
)

// A real open-weight model, not a stand-in: any server that speaks the Chat
// Completions API (llama.cpp, vLLM, Ollama) at GATEWAY_LOCAL_MODEL_URL, serving
// GATEWAY_LOCAL_MODEL. Positions data goes to it, as a self-hosted provider,
// and the trail records the dispatch and what came back; the same request to a
// vendor is refused and the vendor receives nothing.
//
//	GATEWAY_LOCAL_MODEL_URL=http://127.0.0.1:8081/v1 GATEWAY_LOCAL_MODEL=smollm2-360m go test ./server/ -run LocalModel -v
func TestARealLocalModelAnswersPositionsAndAVendorNeverSeesThem(t *testing.T) {
	base, model := os.Getenv("GATEWAY_LOCAL_MODEL_URL"), os.Getenv("GATEWAY_LOCAL_MODEL")
	if base == "" || model == "" {
		t.Skip("GATEWAY_LOCAL_MODEL_URL and GATEWAY_LOCAL_MODEL name a running open-weight model")
	}
	vendor := newUpstream(t)
	trail := &audit.Memory{}
	_, srv := gateway(t, []Provider{
		{ID: "local", Name: "a local open-weight model", Kind: "openai", BaseURL: base, Placement: SelfHosted, Auth: AuthNone},
		{ID: "openai", Name: "OpenAI", Kind: "openai", BaseURL: vendor.srv.URL, Placement: Vendor, Auth: AuthAPIKey},
	}, func(s *Server) { s.trail = trail })
	_, _ = call(t, srv, "PUT", "/v1/accounts/openai", "pm", map[string]string{"apiKey": "sk-proj-abcdefgh"})

	body := map[string]any{
		"provider": "local", "model": model, "dataClass": "positions", "purpose": "position.summarize", "maxTokens": 48,
		"system":   "Answer in one short sentence.",
		"messages": []map[string]string{{"role": "user", "text": "A portfolio holds 1,000 shares bought at $120 and now priced at $135. What is the unrealized profit?"}},
	}
	code, out := call(t, srv, "POST", "/v1/chat", "pm", body)
	if code != http.StatusOK {
		t.Fatalf("the local model: %d %v", code, out)
	}
	res := out["response"].(map[string]any)
	text, _ := res["text"].(string)
	in, _ := res["inputTokens"].(float64)
	gen, _ := res["outputTokens"].(float64)
	if strings.TrimSpace(text) == "" || in == 0 || gen == 0 {
		t.Fatalf("no answer: %v", res)
	}
	if stop := res["stop"]; stop != "end" && stop != "max_tokens" {
		t.Errorf("stop %v", stop)
	}
	t.Logf("%s answered in %v tokens: %q", model, gen, text)

	recs := trail.Records()
	if len(recs) != 2 || recs[0].Outcome != "sent: positions" || recs[1].Outcome != fmt.Sprintf("returned: %s, %d in, %d out", res["stop"], int(in), int(gen)) {
		t.Fatalf("trail: %+v", recs)
	}
	raw, _ := json.Marshal(recs)
	if strings.Contains(string(raw), "1,000 shares") || strings.Contains(string(raw), text) {
		t.Error("the trail holds message content")
	}

	body["provider"] = "openai"
	if code, _ := call(t, srv, "POST", "/v1/chat", "pm", body); code != http.StatusForbidden {
		t.Errorf("positions to a vendor: %d, want 403", code)
	}
	if len(vendor.calls) != 0 {
		t.Errorf("the vendor received %d requests", len(vendor.calls))
	}
}

// Pinned, the same request comes back the same: temperature 0 and one seed,
// sent twice to the real model, give one answer. This is what a compute path
// relies on, checked against the server rather than against the request.
func TestAPinnedRequestToARealModelAnswersTheSameTwice(t *testing.T) {
	base, model := os.Getenv("GATEWAY_LOCAL_MODEL_URL"), os.Getenv("GATEWAY_LOCAL_MODEL")
	if base == "" || model == "" {
		t.Skip("GATEWAY_LOCAL_MODEL_URL and GATEWAY_LOCAL_MODEL name a running open-weight model")
	}
	trail := &audit.Memory{}
	_, srv := gateway(t, []Provider{{ID: "local", Name: "a local open-weight model", Kind: "openai", BaseURL: base, Placement: SelfHosted, Auth: AuthNone}},
		func(s *Server) { s.trail = trail })
	body := map[string]any{
		"provider": "local", "model": model, "dataClass": "positions", "purpose": "position.summarize", "maxTokens": 48,
		"system":   "Answer in one short sentence.",
		"messages": []map[string]string{{"role": "user", "text": "A portfolio holds 1,000 shares bought at $120 and now priced at $135. What is the unrealized profit?"}},
		"pinned":   map[string]any{"seed": 11},
	}
	var answers []string
	for i := 0; i < 3; i++ {
		code, out := call(t, srv, "POST", "/v1/chat", "pm", body)
		if code != http.StatusOK {
			t.Fatalf("pinned call %d: %d %v", i, code, out)
		}
		answers = append(answers, out["response"].(map[string]any)["text"].(string))
	}
	if answers[0] != answers[1] || answers[1] != answers[2] {
		t.Fatalf("pinned answers differ: %q", answers)
	}
	t.Logf("%s, pinned at seed 11, answered %q three times", model, answers[0])
	pinned := 0
	for _, r := range trail.Records() {
		if r.Outcome == "sent: positions, pinned at temperature 0, seed 11" {
			pinned++
		}
	}
	if pinned != 3 {
		t.Errorf("%d pinned dispatches on the trail, want 3: %+v", pinned, trail.Records())
	}
}
