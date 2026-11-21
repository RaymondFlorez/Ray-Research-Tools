package server

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"github.com/raymondflorez/ray-research-tools/services/gateway/accounts"
	"github.com/raymondflorez/ray-research-tools/services/gateway/audit"
	"github.com/raymondflorez/ray-research-tools/services/gateway/identity"
)

// Without DevIdentity, a typed name is nobody; a session token is someone.
func TestOnlyASessionTokenNamesTheCaller(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	v, _ := accounts.Open(k, "")
	s, err := New(Options{Users: []string{"pm"}, Tenants: map[string]string{"pm": "dev"}, Vault: v,
		Identity: identity.Static("https://auth.test", jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: pub, KeyID: "k1", Algorithm: "EdDSA", Use: "sig"}}})})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	mint := func(sub, tenant string) string {
		signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: priv}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
		now := time.Now()
		tok, _ := jwt.Signed(signer).Claims(jwt.Claims{Issuer: "https://auth.test", Subject: sub, Audience: jwt.Audience{identity.Audience},
			IssuedAt: jwt.NewNumericDate(now), Expiry: jwt.NewNumericDate(now.Add(15 * time.Minute))}).Claims(map[string]any{"tenant": tenant, "sid": "s1"}).Serialize()
		return tok
	}
	get := func(set func(*http.Request)) int {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/providers", nil)
		set(req)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if code := get(func(r *http.Request) { r.Header.Set("X-Picasso-User", "pm") }); code != http.StatusUnauthorized {
		t.Errorf("a typed name was accepted without DevIdentity: %d", code)
	}
	if code := get(func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+mint("pm", "dev")) }); code != http.StatusOK {
		t.Errorf("a valid token: %d", code)
	}
	if code := get(func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+mint("pm", "globex")) }); code != http.StatusForbidden {
		t.Errorf("another tenant: %d", code)
	}
}

// A dispatch under a session token names the session on the trail.
func TestADispatchNamesItsSession(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	v, _ := accounts.Open(k, "")
	up := newUpstream(t)
	trail := &audit.Memory{}
	s, err := New(Options{Users: []string{"pm"}, Tenants: map[string]string{"pm": "dev"}, Vault: v, Audit: trail, DevIdentity: true,
		Providers: []Provider{{ID: "vllm", Name: "vLLM", Kind: "openai", BaseURL: up.srv.URL + "/v1", Placement: SelfHosted, Auth: AuthNone}},
		Identity:  identity.Static("https://auth.test", jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: pub, KeyID: "k1", Algorithm: "EdDSA", Use: "sig"}}})})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: priv}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
	now := time.Now()
	tok, _ := jwt.Signed(signer).Claims(jwt.Claims{Issuer: "https://auth.test", Subject: "pm", Audience: jwt.Audience{identity.Audience},
		IssuedAt: jwt.NewNumericDate(now), Expiry: jwt.NewNumericDate(now.Add(15 * time.Minute))}).Claims(map[string]any{"tenant": "dev", "sid": "s1"}).Serialize()
	send := func(set func(*http.Request)) {
		raw, _ := json.Marshal(chatBody("vllm", "positions"))
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/v1/chat", bytes.NewReader(raw))
		set(req)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK {
			t.Fatalf("dispatch: %d", res.StatusCode)
		}
	}
	send(func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+tok) })
	send(func(r *http.Request) { r.Header.Set("X-Picasso-User", "pm") })
	recs := trail.Records()
	if len(recs) != 4 || recs[0].SessionID != "s1" || recs[1].SessionID != "s1" || recs[2].SessionID != "" {
		t.Errorf("session ids on the trail: %+v", recs)
	}
}
