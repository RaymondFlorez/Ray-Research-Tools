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
