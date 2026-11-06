package accounts

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func key(t *testing.T) []byte {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		t.Fatal(err)
	}
	return k
}

func TestTheFileHoldsOnlyCiphertextAndReopens(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	k := key(t)
	v, err := Open(k, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := v.Put("pm", "anthropic", APIKey, "sk-ant-api03-secret-value-WXYZ"); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if bytes.Contains(raw, []byte("secret-value")) {
		t.Fatal("the file holds the secret in plain text")
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", info.Mode().Perm())
	}
	again, err := Open(k, path)
	if err != nil {
		t.Fatal(err)
	}
	if s, err := again.Secret("pm", "anthropic"); err != nil || s != "sk-ant-api03-secret-value-WXYZ" {
		t.Errorf("%q %v", s, err)
	}
	c := again.Connections("pm")["anthropic"]
	if c.Hint != "…WXYZ" || c.Method != APIKey {
		t.Errorf("%+v", c)
	}
	if strings.Contains(mustJSON(t, again.Connections("pm")), "secret") {
		t.Error("a connection listing carries the secret")
	}
	wrong, _ := Open(key(t), path)
	if _, err := wrong.Secret("pm", "anthropic"); err == nil {
		t.Error("opened under a different key")
	}
}

func TestASealedSecretCannotBeMovedToAnotherUser(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	k := key(t)
	v, _ := Open(k, path)
	_ = v.Put("pm", "openrouter", OAuth, "sk-or-v1-pms-own-key-1234")
	var rows []map[string]any
	raw, _ := os.ReadFile(path)
	_ = json.Unmarshal(raw, &rows)
	rows[0]["user"] = "analyst"
	raw, _ = json.Marshal(rows)
	_ = os.WriteFile(path, raw, 0o600)
	tampered, _ := Open(k, path)
	if _, err := tampered.Secret("analyst", "openrouter"); err == nil {
		t.Error("the pm's key opened as the analyst's")
	}
}

func TestDisconnect(t *testing.T) {
	v, _ := Open(key(t), "")
	_ = v.Put("pm", "gemini", APIKey, "AIza-something-long")
	if err := v.Delete("pm", "gemini"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Secret("pm", "gemini"); !errors.Is(err, ErrNotConnected) {
		t.Errorf("%v", err)
	}
	if err := v.Put("pm", "gemini", APIKey, ""); err == nil {
		t.Error("an empty credential was stored")
	}
	if _, err := Open(make([]byte, 16), ""); err == nil {
		t.Error("a 16-byte key was accepted")
	}
}

func mustJSON(t *testing.T, v any) string {
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// Rotating the vault key re-seals every credential, and the old key then opens nothing.
func TestRekeyReSealsEverythingOrNothing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	oldKey, newKey := key(t), key(t)
	v, err := Open(oldKey, path)
	if err != nil {
		t.Fatal(err)
	}
	_ = v.Put("pm", "anthropic", APIKey, "sk-ant-api03-secret-value-WXYZ")
	_ = v.Put("analyst", "openrouter", OAuth, "sk-or-v1-another-secret-ABCD")
	before, _ := os.ReadFile(path)

	if n, err := v.Rekey(newKey); err != nil || n != 2 {
		t.Fatalf("rekey: %d (%v)", n, err)
	}
	if s, _ := v.Secret("pm", "anthropic"); s != "sk-ant-api03-secret-value-WXYZ" {
		t.Errorf("after rekey, in this process: %q", s)
	}
	after, _ := os.ReadFile(path)
	if bytes.Equal(before, after) {
		t.Fatal("the file did not change")
	}
	reopened, _ := Open(newKey, path)
	if s, _ := reopened.Secret("analyst", "openrouter"); s != "sk-or-v1-another-secret-ABCD" {
		t.Errorf("reopened under the new key: %q", s)
	}
	stale, _ := Open(oldKey, path)
	if _, err := stale.Secret("pm", "anthropic"); err == nil {
		t.Error("the old key still opens a credential")
	}

	// A row the current key cannot open: nothing is re-sealed, nothing is written.
	broken, _ := Open(key(t), path)
	if _, err := broken.Rekey(key(t)); err == nil || !strings.Contains(err.Error(), "nothing was re-sealed") {
		t.Errorf("rekey under the wrong key: %v", err)
	}
	if now, _ := os.ReadFile(path); !bytes.Equal(now, after) {
		t.Error("a failed rekey changed the file")
	}
}
