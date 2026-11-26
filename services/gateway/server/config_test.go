package server

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"testing"

	"github.com/raymondflorez/ray-research-tools/services/gateway/accounts"
)

func TestTheShippedProviderFileIsValid(t *testing.T) {
	raw, err := os.ReadFile("../config/providers.json")
	if err != nil {
		t.Fatal(err)
	}
	var providers []Provider
	if err := json.Unmarshal(raw, &providers); err != nil {
		t.Fatal(err)
	}
	k := make([]byte, 32)
	_, _ = rand.Read(k)
	v, _ := accounts.Open(k, "")
	if _, err := New(Options{Providers: providers, Vault: v, PublicURL: "http://g", ReturnURL: "http://a"}); err != nil {
		t.Fatal(err)
	}
}

// systemAsUser does something only to Chat Completions requests; anywhere
// else it would be a setting that silently does nothing, so it is refused.
func TestSystemAsUserIsRefusedWhereItWouldDoNothing(t *testing.T) {
	p := Provider{ID: "claude", Name: "Claude", Kind: "anthropic", Placement: Vendor, Auth: AuthAPIKey, SystemAsUser: true}
	if err := p.Validate(); err == nil {
		t.Error("systemAsUser on an Anthropic provider was accepted")
	}
	p = Provider{ID: "phi", Name: "Phi-3", Kind: "openai", BaseURL: "http://127.0.0.1:8084/v1", Placement: SelfHosted, Auth: AuthNone, SystemAsUser: true}
	if err := p.Validate(); err != nil {
		t.Errorf("systemAsUser on a Chat Completions provider: %v", err)
	}
}
