package identity

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

type contract struct {
	Issuer string             `json:"issuer"`
	JWKS   jose.JSONWebKeySet `json:"jwks"`
	Cases  []struct {
		Name     string   `json:"name"`
		Token    string   `json:"token"`
		Now      int64    `json:"now"`
		Revoked  []string `json:"revoked"`
		Expected struct {
			OK     bool   `json:"ok"`
			User   string `json:"user"`
			Tenant string `json:"tenant"`
			Reason string `json:"reason"`
		} `json:"expected"`
	} `json:"cases"`
}

// The tokens and verdicts the TypeScript verifier wrote: this one must agree.
func TestVerdictsMatchTheTypeScriptVerifier(t *testing.T) {
	raw, err := os.ReadFile("../../auth/testdata/tokens.json")
	if err != nil {
		t.Fatal(err)
	}
	var c contract
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if len(c.Cases) < 10 {
		t.Fatalf("only %d cases", len(c.Cases))
	}
	for _, tc := range c.Cases {
		v := Static(c.Issuer, c.JWKS)
		v.Revoke(tc.Revoked...)
		now := time.Unix(tc.Now, 0)
		v.Now = func() time.Time { return now }
		s, refusal := v.Verify(context.Background(), tc.Token)
		switch {
		case tc.Expected.OK && refusal != nil:
			t.Errorf("%s: refused (%v), the TypeScript verifier accepts it", tc.Name, refusal)
		case tc.Expected.OK && (s.User != tc.Expected.User || s.Tenant != tc.Expected.Tenant):
			t.Errorf("%s: %+v", tc.Name, s)
		case !tc.Expected.OK && refusal == nil:
			t.Errorf("%s: accepted, the TypeScript verifier refuses it (%s)", tc.Name, tc.Expected.Reason)
		case !tc.Expected.OK && refusal.Reason != tc.Expected.Reason:
			t.Errorf("%s: refused as %s (%s), the TypeScript verifier says %s", tc.Name, refusal.Reason, refusal.Message, tc.Expected.Reason)
		}
	}
}
