package server

import (
	"bufio"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"strings"
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

// A stream outlives the request that verified it. Logging out must still end it.
func TestAStreamEndsWhenItsSessionLogsOut(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	verifier := identity.Static("https://auth.test", jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: pub, KeyID: "k1", Algorithm: "EdDSA", Use: "sig"}}})
	s := &Server{
		Reader:      access.Reader{Store: pit.NewMemory()},
		Hub:         stream.NewHub(ingest.NewSymbology(), time.Second),
		Users:       Users{"pm": {UserID: "pm", TenantID: "dev", Vendors: map[string]bool{}}},
		Identity:    verifier,
		HealthEvery: 20 * time.Millisecond,
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/stream?subject=md.equity.NVDA", nil)
	req.Header.Set("Authorization", "Bearer "+mint(t, priv, "pm", "dev"))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	lines := make(chan string)
	go func() {
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	next := func(prefix string) string {
		deadline := time.After(3 * time.Second)
		for {
			select {
			case l, ok := <-lines:
				if !ok {
					return "closed"
				}
				if strings.HasPrefix(l, prefix) {
					return l
				}
			case <-deadline:
				return "timeout"
			}
		}
	}
	if got := next("event: health"); got != "event: health" {
		t.Fatalf("a live session's stream: %s", got)
	}
	verifier.Revoke("s1")
	if got := next("event: ended"); got != "event: ended" {
		t.Fatalf("after logout: %s, want the stream ended", got)
	}
	if got := next("data:"); !strings.Contains(got, `"reason":"revoked"`) {
		t.Errorf("ended with %s", got)
	}
	if got := next("event:"); got != "closed" {
		t.Errorf("after ended: %s, want the stream closed", got)
	}
}

// A stream lives no longer than the token that opened it, plus the leeway.
func TestAStreamEndsWhenItsTokenExpires(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	s := &Server{
		Reader:      access.Reader{Store: pit.NewMemory()},
		Hub:         stream.NewHub(ingest.NewSymbology(), time.Second),
		Users:       Users{"pm": {UserID: "pm", TenantID: "dev", Vendors: map[string]bool{}}},
		Identity:    identity.Static("https://auth.test", jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: pub, KeyID: "k1", Algorithm: "EdDSA", Use: "sig"}}}),
		HealthEvery: 20 * time.Millisecond,
	}
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()
	// Expired 28 seconds ago (token times are whole seconds, so 28 to 29): inside the leeway when
	// the stream opens, past it within two seconds.
	signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.EdDSA, Key: priv}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
	exp := time.Now().Add(-28 * time.Second)
	token, _ := jwt.Signed(signer).Claims(jwt.Claims{Issuer: "https://auth.test", Subject: "pm", Audience: jwt.Audience{identity.Audience},
		IssuedAt: jwt.NewNumericDate(exp.Add(-15 * time.Minute)), Expiry: jwt.NewNumericDate(exp)}).
		Claims(map[string]any{"tenant": "dev", "sid": "s-exp"}).Serialize()

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/v1/stream?subject=md.equity.NVDA", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("opening inside the leeway: %d", res.StatusCode)
	}
	sc := bufio.NewScanner(res.Body)
	var ended, data string
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) && sc.Scan() {
		if line := sc.Text(); line == "event: ended" {
			ended = line
		} else if ended != "" && strings.HasPrefix(line, "data:") {
			data = line
			break
		}
	}
	if !strings.Contains(data, `"reason":"expired"`) {
		t.Fatalf("stream after expiry: %q %q, want ended for expiry", ended, data)
	}
	if sc.Scan() && strings.HasPrefix(sc.Text(), "event:") {
		t.Errorf("the stream went on after ending: %q", sc.Text())
	}
}
