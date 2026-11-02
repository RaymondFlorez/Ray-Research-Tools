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
