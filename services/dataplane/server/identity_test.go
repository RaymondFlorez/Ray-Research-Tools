package server

import (
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/access"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/identity"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/ingest"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/stream"
)

func mint(t *testing.T, key ed25519.PrivateKey, sub, tenant string) string {
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: key}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	tok, err := jwt.Signed(signer).Claims(jwt.Claims{Issuer: "https://auth.test", Subject: sub, Audience: jwt.Audience{identity.Audience},
		IssuedAt: jwt.NewNumericDate(now), Expiry: jwt.NewNumericDate(now.Add(15 * time.Minute))}).
		Claims(map[string]any{"tenant": tenant, "sid": "s1"}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	return tok
}

// Without DevIdentity, a typed name is nobody; a session token is someone.
func TestOnlyASessionTokenNamesTheCaller(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	s := &Server{
		Reader:   access.Reader{Store: pit.NewMemory()},
		Hub:      stream.NewHub(ingest.NewSymbology(), time.Second),
		Users:    Users{"pm": {UserID: "pm", TenantID: "dev", Vendors: map[string]bool{}}},
		Identity: identity.Static("https://auth.test", jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: pub, KeyID: "k1", Algorithm: "EdDSA", Use: "sig"}}}),
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	get := func(set func(*http.Request)) int {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/asof?key=k&knowledge=2024-01-01", nil)
		set(req)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if code := get(func(r *http.Request) { r.Header.Set(UserHeader, "pm") }); code != http.StatusUnauthorized {
		t.Errorf("a typed name was accepted without DevIdentity: %d", code)
	}
	if code := get(func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+mint(t, priv, "pm", "dev")) }); code != http.StatusOK {
		t.Errorf("a valid token: %d", code)
	}
	if code := get(func(r *http.Request) {
		r.AddCookie(&http.Cookie{Name: identity.Cookie, Value: mint(t, priv, "pm", "dev")})
	}); code != http.StatusOK {
		t.Errorf("the token as a cookie: %d", code)
	}
	if code := get(func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+mint(t, priv, "pm", "globex")) }); code != http.StatusForbidden {
		t.Errorf("a token for the user in another tenant: %d", code)
	}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	if code := get(func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+mint(t, other, "pm", "dev")) }); code != http.StatusUnauthorized {
		t.Errorf("a token signed by another key: %d", code)
	}
	if code := get(func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+mint(t, priv, "mallory", "dev")) }); code != http.StatusUnauthorized {
		t.Errorf("a valid token for a user with no entitlements here: %d", code)
	}
}
