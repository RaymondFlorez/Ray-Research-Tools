package identity

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// A stand-in picasso-auth: a key set and a revocation list that can go down.
type standIn struct {
	mu      sync.Mutex
	revoked []string
	down    bool
	reads   int
}

func TestALogoutReachesTheServiceAndAnOutageRefusesEveryone(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	auth := &standIn{revoked: []string{}}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth.mu.Lock()
		defer auth.mu.Unlock()
		switch {
		case auth.down:
			http.Error(w, "down", http.StatusServiceUnavailable)
		case r.URL.Path == "/.well-known/jwks.json":
			_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: pub, KeyID: "k1", Algorithm: "EdDSA", Use: "sig"}}})
		case r.URL.Path == "/auth/revoked":
			auth.reads++
			_ = json.NewEncoder(w).Encode(map[string][]string{"sids": auth.revoked})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	clock := time.Now()
	v := Remote(srv.URL)
	v.Now = func() time.Time { return clock }
	signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: priv}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
	token := func(sid string) string {
		tok, err := jwt.Signed(signer).Claims(jwt.Claims{Issuer: srv.URL, Audience: jwt.Audience{Audience}, Subject: "pm",
			IssuedAt: jwt.NewNumericDate(clock), Expiry: jwt.NewNumericDate(clock.Add(15 * time.Minute))}).
			Claims(private{Tenant: "dev", SID: sid}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	verify := func(tok string) string {
		if _, r := v.Verify(context.Background(), tok); r != nil {
			return r.Reason
		}
		return "ok"
	}

	a, b := token("sid-a"), token("sid-b")
	if got := verify(a); got != "ok" {
		t.Fatalf("a live session: %s", got)
	}
	auth.mu.Lock()
	auth.revoked = []string{"sid-a"}
	auth.mu.Unlock()

	// Within the refresh interval the old copy stands; then the logout lands.
	clock = clock.Add(RevocationRefresh - time.Second)
	if got := verify(a); got != "ok" {
		t.Errorf("before the list is re-read: %s", got)
	}
	clock = clock.Add(time.Second)
	if got := verify(a); got != "revoked" {
		t.Errorf("after the logout reaches the list: %s, want revoked", got)
	}
	if got := verify(b); got != "ok" {
		t.Errorf("another session after that logout: %s", got)
	}
	auth.mu.Lock()
	reads := auth.reads
	auth.mu.Unlock()
	if reads != 2 {
		t.Errorf("%d reads of the list for 4 verifications across one refresh interval, want 2", reads)
	}

	// picasso-auth goes down: the last copy serves until it is too old.
	auth.mu.Lock()
	auth.down = true
	auth.mu.Unlock()
	clock = clock.Add(RevocationMaxStale)
	if got := verify(b); got != "ok" {
		t.Errorf("at the staleness limit: %s", got)
	}
	clock = clock.Add(time.Second)
	if got := verify(b); got != "revocation_unknown" {
		t.Errorf("past it: %s, want revocation_unknown", got)
	}
	auth.mu.Lock()
	auth.down = false
	auth.mu.Unlock()
	clock = clock.Add(RevocationRefresh)
	if got := verify(b); got != "ok" {
		t.Errorf("once picasso-auth answers again: %s", got)
	}
}
