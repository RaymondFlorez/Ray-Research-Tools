package provider

// The servers here are STAND-INS written to each provider's documented API,
// answering with canned bodies. They test what the adapters send and how they
// read the documented answer shapes; they are not the providers.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

type seen struct {
	path    string
	headers http.Header
	body    map[string]any
}

func standIn(t *testing.T, status int, answer string) (*httptest.Server, *seen) {
	s := &seen{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.path, s.headers = r.URL.Path, r.Header.Clone()
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &s.body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(srv.Close)
	return srv, s
}

var req = Request{Model: "m", System: "Be brief.", Messages: []Message{{"user", "Hi"}, {"assistant", "Hello."}, {"user", "2+2?"}}, MaxTokens: 64}

func TestAnthropicThroughTheSDK(t *testing.T) {
	srv, s := standIn(t, 200, `{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5-5",
	 "content":[{"type":"text","text":"4"}],"stop_reason":"end_turn","stop_sequence":null,
	 "usage":{"input_tokens":12,"output_tokens":1}}`)
	r := req
	r.Model = "claude-opus-5-5"
	out, err := Anthropic{BaseURL: srv.URL}.Chat(context.Background(), "sk-test", r)
	if err != nil {
		t.Fatal(err)
	}
	if out.Text != "4" || out.Stop != StopEnd || out.InputTokens != 12 || out.OutputTokens != 1 || out.Model != "claude-opus-5-5" {
		t.Errorf("%+v", out)
	}
	// The SDK sends an API key as a bearer token; api.anthropic.com accepts
	// that form (TestAnthropicLiveRejectsAnInvalidKey reads its answer).
	if s.path != "/v1/messages" || s.headers.Get("Authorization") != "Bearer sk-test" || s.headers.Get("Anthropic-Version") == "" {
		t.Errorf("sent %s with %v", s.path, s.headers)
	}
	msgs := s.body["messages"].([]any)
	if len(msgs) != 3 || msgs[1].(map[string]any)["role"] != "assistant" || s.body["max_tokens"].(float64) != 64 {
		t.Errorf("body %v", s.body)
	}
	for _, sampling := range []string{"temperature", "top_p", "top_k"} {
		if _, ok := s.body[sampling]; ok {
			t.Errorf("sent %s, which current Claude models reject", sampling)
		}
	}
}

func TestAnthropicTakesNothingFromTheGatewaysEnvironment(t *testing.T) {
	elsewhere, leaked := standIn(t, 200, `{}`)
	srv, s := standIn(t, 200, `{"id":"m","type":"message","role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}`)
	t.Setenv("ANTHROPIC_API_KEY", "sk-operators-own")
	t.Setenv("ANTHROPIC_BASE_URL", elsewhere.URL)
	t.Setenv("ANTHROPIC_CUSTOM_HEADERS", "X-Leak: yes")
	if _, err := (Anthropic{BaseURL: srv.URL}).Chat(context.Background(), "", req); err == nil {
		t.Fatal("a user with no key was served, presumably on the operator's")
	}
	if _, err := (Anthropic{BaseURL: srv.URL}).Chat(context.Background(), "sk-user", req); err != nil {
		t.Fatal(err)
	}
	if leaked.path != "" || s.headers.Get("X-Leak") != "" || s.headers.Get("Authorization") != "Bearer sk-user" {
		t.Errorf("environment leaked in: elsewhere saw %q, headers %v", leaked.path, s.headers)
	}
	// With no base URL configured, ANTHROPIC_BASE_URL still does not apply.
	_, _ = Anthropic{}.Chat(canceled(), "sk-user", req)
	if leaked.path != "" {
		t.Error("ANTHROPIC_BASE_URL redirected a request")
	}
}

func canceled() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return ctx
}

func TestAnthropicRefusalAndErrors(t *testing.T) {
	srv, _ := standIn(t, 200, `{"id":"msg_2","type":"message","role":"assistant","model":"claude-opus-5-5","content":[],
	 "stop_reason":"refusal","stop_details":{"type":"refusal","category":"cyber","explanation":"declined"},"usage":{"input_tokens":5,"output_tokens":0}}`)
	out, err := Anthropic{BaseURL: srv.URL}.Chat(context.Background(), "sk-test", req)
	if err != nil || out.Stop != StopRefusal || out.StopDetail != "cyber declined" {
		t.Errorf("%+v %v", out, err)
	}
	bad, _ := standIn(t, 401, `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`)
	_, err = Anthropic{BaseURL: bad.URL}.Chat(context.Background(), "sk-wrong", req)
	var perr *Error
	if !asError(err, &perr) || perr.Status != 401 || !strings.Contains(perr.Message, "invalid x-api-key") || strings.Contains(perr.Message, "sk-wrong") {
		t.Errorf("%v", err)
	}
}

func TestOpenAICompatible(t *testing.T) {
	srv, s := standIn(t, 200, `{"id":"c1","object":"chat.completion","model":"llama-3.3-70b",
	 "choices":[{"index":0,"message":{"role":"assistant","content":"4"},"finish_reason":"length"}],
	 "usage":{"prompt_tokens":20,"completion_tokens":1,"total_tokens":21}}`)
	o := OpenAICompatible{Name: "local", BaseURL: srv.URL + "/v1", MaxTokensField: "max_completion_tokens", Headers: map[string]string{"X-Title": "Picasso"}}
	out, err := o.Chat(context.Background(), "key-1", req)
	if err != nil {
		t.Fatal(err)
	}
	if out.Text != "4" || out.Stop != StopMaxTokens || out.InputTokens != 20 || out.Model != "llama-3.3-70b" {
		t.Errorf("%+v", out)
	}
	if s.path != "/v1/chat/completions" || s.headers.Get("Authorization") != "Bearer key-1" || s.headers.Get("X-Title") != "Picasso" {
		t.Errorf("sent %s %v", s.path, s.headers)
	}
	msgs := s.body["messages"].([]any)
	if len(msgs) != 4 || msgs[0].(map[string]any)["role"] != "system" || s.body["max_completion_tokens"].(float64) != 64 {
		t.Errorf("body %v", s.body)
	}
	if _, ok := s.body["max_tokens"]; ok {
		t.Error("sent max_tokens as well")
	}

	// A local server with no key gets no Authorization header at all.
	_, _ = OpenAICompatible{Name: "ollama", BaseURL: srv.URL + "/v1"}.Chat(context.Background(), "", req)
	if _, ok := s.headers["Authorization"]; ok || s.body["max_tokens"].(float64) != 64 {
		t.Errorf("keyless: %v %v", s.headers, s.body)
	}

	refused, _ := standIn(t, 200, `{"model":"gpt","choices":[{"message":{"content":null,"refusal":"I can't help with that."},"finish_reason":"stop"}],"usage":{}}`)
	if out, _ := (OpenAICompatible{Name: "openai", BaseURL: refused.URL}).Chat(context.Background(), "k", req); out.Stop != StopRefusal || out.StopDetail != "I can't help with that." {
		t.Errorf("refusal: %+v", out)
	}
	bad, _ := standIn(t, 429, `{"error":{"message":"Rate limit reached","type":"requests","code":"rate_limit_exceeded"}}`)
	_, err = OpenAICompatible{Name: "openai", BaseURL: bad.URL}.Chat(context.Background(), "k", req)
	var perr *Error
	if !asError(err, &perr) || perr.Status != 429 || perr.Message != "Rate limit reached" {
		t.Errorf("%v", err)
	}
}

func TestGemini(t *testing.T) {
	srv, s := standIn(t, 200, `{"candidates":[{"content":{"role":"model","parts":[{"text":"4"}]},"finishReason":"STOP"}],
	 "usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":1},"modelVersion":"gemini-x"}`)
	out, err := Gemini{BaseURL: srv.URL}.Chat(context.Background(), "g-key", Request{Model: "gemini-x", System: "Be brief.", Messages: req.Messages, MaxTokens: 64})
	if err != nil || out.Text != "4" || out.Stop != StopEnd || out.InputTokens != 9 {
		t.Fatalf("%+v %v", out, err)
	}
	if s.path != "/v1beta/models/gemini-x:generateContent" || s.headers.Get("X-Goog-Api-Key") != "g-key" {
		t.Errorf("sent %s %v", s.path, s.headers)
	}
	contents := s.body["contents"].([]any)
	if contents[1].(map[string]any)["role"] != "model" || s.body["systemInstruction"] == nil || s.body["generationConfig"].(map[string]any)["maxOutputTokens"].(float64) != 64 {
		t.Errorf("body %v", s.body)
	}
	blocked, _ := standIn(t, 200, `{"promptFeedback":{"blockReason":"SAFETY"},"usageMetadata":{"promptTokenCount":9}}`)
	if out, err := (Gemini{BaseURL: blocked.URL}).Chat(context.Background(), "g", Request{Model: "g", Messages: req.Messages, MaxTokens: 8}); err != nil || out.Stop != StopRefusal || out.StopDetail != "SAFETY" {
		t.Errorf("blocked prompt: %+v %v", out, err)
	}
}

func TestRequestsNoProviderCouldServeAreRefused(t *testing.T) {
	for _, bad := range []Request{
		{Messages: req.Messages, MaxTokens: 8},
		{Model: "m", MaxTokens: 8},
		{Model: "m", Messages: []Message{{"assistant", "x"}}, MaxTokens: 8},
		{Model: "m", Messages: []Message{{"user", "x"}, {"system", "y"}}, MaxTokens: 8},
		{Model: "m", Messages: req.Messages},
	} {
		if bad.Validate() == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}

// Against the real API, with a key that cannot be valid: Anthropic's is the
// one provider host this environment can reach. GATEWAY_LIVE=1 runs it.
func TestAnthropicLiveRejectsAnInvalidKey(t *testing.T) {
	if os.Getenv("GATEWAY_LIVE") != "1" {
		t.Skip("GATEWAY_LIVE=1 calls api.anthropic.com")
	}
	_, err := Anthropic{}.Chat(context.Background(), "sk-ant-not-a-real-key", Request{Model: "claude-opus-5-5", Messages: []Message{{"user", "Hi"}}, MaxTokens: 8})
	var perr *Error
	if !asError(err, &perr) || perr.Status != 401 || strings.Contains(perr.Message, "sk-ant-not-a-real-key") {
		t.Fatalf("%v", err)
	}
	t.Logf("live: %s", perr.Message)
}
