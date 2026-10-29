package server

// The providers here are STAND-INS: local servers written to the documented
// Chat Completions API and to OpenRouter's documented PKCE key exchange.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/gateway/accounts"
)

type upstream struct {
	mu    sync.Mutex
	calls []struct{ auth, body string }
	srv   *httptest.Server
}

func newUpstream(t *testing.T) *upstream {
	u := &upstream{}
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		u.calls = append(u.calls, struct{ auth, body string }{r.Header.Get("Authorization"), string(raw)})
		u.mu.Unlock()
		_, _ = w.Write([]byte(`{"model":"qwen-coder-32b","choices":[{"message":{"content":"SELECT 1"},"finish_reason":"stop"}],"usage":{"prompt_tokens":30,"completion_tokens":3}}`))
	}))
	t.Cleanup(u.srv.Close)
	return u
}

func gateway(t *testing.T, providers []Provider, extra ...func(*Server)) (*Server, *httptest.Server) {
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	v, _ := accounts.Open(k, "")
	s, err := New(Options{Providers: providers, Users: []string{"pm", "analyst"}, Vault: v, PublicURL: "http://gateway.test", ReturnURL: "http://app.test/models.html"})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range extra {
		f(s)
	}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return s, srv
}

func call(t *testing.T, srv *httptest.Server, method, path, user string, body any) (int, map[string]any) {
	var rd io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rd = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, srv.URL+path, rd)
	if user != "" {
		req.Header.Set("X-Picasso-User", user)
	}
	res, err := srv.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func chatBody(provider, class string) map[string]any {
	return map[string]any{"provider": provider, "model": "qwen-coder-32b", "messages": []map[string]string{{"role": "user", "text": "count the rows"}}, "maxTokens": 64, "dataClass": class}
}

func TestEachUserCallsOnTheirOwnAccount(t *testing.T) {
	up := newUpstream(t)
	_, srv := gateway(t, []Provider{{ID: "together", Name: "Together", Kind: "openai", BaseURL: up.srv.URL + "/v1", Placement: Vendor, Auth: AuthAPIKey}})

	if code, _ := call(t, srv, "POST", "/v1/chat", "pm", chatBody("together", "public")); code != http.StatusPreconditionRequired {
		t.Errorf("not connected: %d", code)
	}
	if code, out := call(t, srv, "PUT", "/v1/accounts/together", "pm", map[string]string{"apiKey": "tg-pms-key-0001"}); code != 200 || out["hint"] != "…0001" {
		t.Fatalf("%d %v", code, out)
	}
	_, _ = call(t, srv, "PUT", "/v1/accounts/together", "analyst", map[string]string{"apiKey": "tg-analysts-key-0002"})

	code, out := call(t, srv, "POST", "/v1/chat", "pm", chatBody("together", "licensed"))
	if code != 200 || out["response"].(map[string]any)["text"] != "SELECT 1" {
		t.Fatalf("%d %v", code, out)
	}
	_, _ = call(t, srv, "POST", "/v1/chat", "analyst", chatBody("together", "public"))
	if len(up.calls) != 2 || up.calls[0].auth != "Bearer tg-pms-key-0001" || up.calls[1].auth != "Bearer tg-analysts-key-0002" {
		t.Errorf("credentials used: %+v", up.calls)
	}

	_, listed := call(t, srv, "GET", "/v1/providers", "pm", nil)
	raw, _ := json.Marshal(listed)
	if strings.Contains(string(raw), "tg-pms-key") || !strings.Contains(string(raw), `"connected":true`) {
		t.Errorf("listing: %s", raw)
	}
	if code, _ := call(t, srv, "GET", "/v1/providers", "", nil); code != http.StatusUnauthorized {
		t.Errorf("no user: %d", code)
	}
}

func TestPositionsNeverReachAVendor(t *testing.T) {
	vendor, local := newUpstream(t), newUpstream(t)
	_, srv := gateway(t, []Provider{
		{ID: "openai", Name: "OpenAI", Kind: "openai", BaseURL: vendor.srv.URL, Placement: Vendor, Auth: AuthAPIKey},
		{ID: "vllm", Name: "vLLM", Kind: "openai", BaseURL: local.srv.URL, Placement: SelfHosted, Auth: AuthNone},
	})
	_, _ = call(t, srv, "PUT", "/v1/accounts/openai", "pm", map[string]string{"apiKey": "sk-proj-abcdefgh"})
	for _, class := range []string{"positions", "mnpi_risk"} {
		if code, out := call(t, srv, "POST", "/v1/chat", "pm", chatBody("openai", class)); code != http.StatusForbidden || !strings.Contains(out["error"].(string), "self-hosted") {
			t.Errorf("%s to a vendor: %d %v", class, code, out)
		}
		if code, _ := call(t, srv, "POST", "/v1/chat", "pm", chatBody("vllm", class)); code != 200 {
			t.Errorf("%s to self-hosted: %d", class, code)
		}
	}
	if len(vendor.calls) != 0 {
		t.Errorf("the vendor received %d requests", len(vendor.calls))
	}
	if code, _ := call(t, srv, "POST", "/v1/chat", "pm", chatBody("vllm", "")); code != http.StatusBadRequest {
		t.Errorf("no class: %d", code)
	}
	_, audit := call(t, srv, "GET", "/v1/audit", "pm", nil)
	entries := audit["entries"].([]any)
	if len(entries) != 5 || !strings.HasPrefix(entries[0].(map[string]any)["outcome"].(string), "refused") {
		t.Errorf("audit: %v", entries)
	}
	raw, _ := json.Marshal(audit)
	if strings.Contains(string(raw), "count the rows") {
		t.Error("the audit log holds message content")
	}
	if _, other := call(t, srv, "GET", "/v1/audit", "analyst", nil); len(other["entries"].([]any)) != 0 {
		t.Error("one user read another's audit entries")
	}
}

func TestAVendorWithNoUserCredentialIsAConfigurationError(t *testing.T) {
	k := make([]byte, 32)
	v, _ := accounts.Open(k, "")
	if _, err := New(Options{Vault: v, Providers: []Provider{{ID: "x", Name: "X", Kind: "openai", BaseURL: "https://x", Placement: Vendor, Auth: AuthNone}}}); err == nil {
		t.Error("accepted a vendor reached on the operator's account for every user")
	}
	if _, err := New(Options{Vault: v, Providers: []Provider{{ID: "or", Name: "OR", Kind: "openai", BaseURL: "https://x", Placement: Vendor, Auth: AuthOAuth, OAuth: &OAuthConfig{AuthorizeURL: "a", ExchangeURL: "b"}}}}); err == nil {
		t.Error("accepted OAuth with nowhere to send the browser back")
	}
}

// OpenRouter's PKCE flow, played by the test: the browser is sent to the
// authorize URL, the provider redirects to callback_url with a code, and the
// gateway exchanges code and verifier for a key.
func TestSignInWithPKCE(t *testing.T) {
	var gotVerifier string
	issued := map[string]string{} // code -> challenge
	exchange := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		sum := sha256.Sum256([]byte(body["code_verifier"]))
		if challenge, ok := issued[body["code"]]; !ok || base64.RawURLEncoding.EncodeToString(sum[:]) != challenge || body["code_challenge_method"] != "S256" {
			http.Error(w, `{"error":"invalid code"}`, http.StatusForbidden)
			return
		}
		gotVerifier = body["code_verifier"]
		_, _ = w.Write([]byte(`{"key":"sk-or-v1-signed-in-9876","user_id":"u"}`))
	}))
	defer exchange.Close()
	up := newUpstream(t)
	s, srv := gateway(t, []Provider{{ID: "openrouter", Name: "OpenRouter", Kind: "openai", BaseURL: up.srv.URL, Placement: Vendor, Auth: AuthOAuth,
		OAuth: &OAuthConfig{AuthorizeURL: "https://openrouter.test/auth", ExchangeURL: exchange.URL}}})
	noRedirect := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	signIn := func() (callback *url.URL) {
		_, out := call(t, srv, "POST", "/v1/accounts/openrouter/oauth", "pm", nil)
		authorize, err := url.Parse(out["authorizeUrl"].(string))
		if err != nil || authorize.Host != "openrouter.test" || authorize.Query().Get("code_challenge_method") != "S256" {
			t.Fatalf("authorize URL %v", out)
		}
		callback, _ = url.Parse(authorize.Query().Get("callback_url"))
		if callback.Host != "gateway.test" || callback.Query().Get("state") == "" {
			t.Fatalf("callback %v", callback)
		}
		issued["code-1"] = authorize.Query().Get("code_challenge")
		return callback
	}
	land := func(callback *url.URL, code string) *url.URL {
		q := callback.Query()
		if code != "" {
			q.Set("code", code)
		}
		res, err := noRedirect.Get(srv.URL + callback.Path + "?" + q.Encode())
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusSeeOther {
			t.Fatalf("callback answered %d", res.StatusCode)
		}
		loc, _ := url.Parse(res.Header.Get("Location"))
		if loc.Host != "app.test" {
			t.Fatalf("sent the browser to %v", loc)
		}
		return loc
	}

	callback := signIn()
	if loc := land(callback, "code-1"); loc.Query().Get("connected") != "openrouter" {
		t.Fatalf("after sign-in: %v", loc)
	}
	if gotVerifier == "" {
		t.Fatal("no exchange")
	}
	_, out := call(t, srv, "POST", "/v1/chat", "pm", chatBody("openrouter", "public"))
	if out["response"] == nil || up.calls[0].auth != "Bearer sk-or-v1-signed-in-9876" {
		t.Errorf("chat after sign-in: %v %+v", out, up.calls)
	}
	// The analyst did not sign in, and the pm's key is not theirs.
	if code, _ := call(t, srv, "POST", "/v1/chat", "analyst", chatBody("openrouter", "public")); code != http.StatusPreconditionRequired {
		t.Errorf("analyst: %d", code)
	}

	// A callback works once.
	if loc := land(callback, "code-1"); !strings.Contains(loc.Query().Get("error"), "already been used") {
		t.Errorf("replayed callback: %v", loc)
	}
	// A cancelled sign-in comes back with no code.
	if loc := land(signIn(), ""); !strings.Contains(loc.Query().Get("error"), "no code") {
		t.Errorf("cancelled: %v", loc)
	}
	// A code the provider did not issue for this challenge is refused.
	if loc := land(signIn(), "code-forged"); !strings.Contains(loc.Query().Get("error"), "refused the sign-in") {
		t.Errorf("forged code: %v", loc)
	}
	// And a sign-in left too long expires.
	late := signIn()
	s.now = func() time.Time { return time.Now().Add(11 * time.Minute) }
	if loc := land(late, "code-1"); !strings.Contains(loc.Query().Get("error"), "ten minutes") {
		t.Errorf("expired: %v", loc)
	}
}
