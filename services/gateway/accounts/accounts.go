// Package accounts holds each user's credential for each model provider,
// sealed at rest, and never hands one back to the user who stored it.
//
// A user connects a provider by signing in where the provider offers it (an
// OAuth key exchange, as OpenRouter does) or by pasting an API key from their
// account with that provider. Either way the secret goes in once and only the
// gateway reads it again, to make a call on that user's behalf. The browser
// gets whether a provider is connected and the secret's last four characters.
//
// Sealing is AES-256-GCM under a key the operator supplies. The additional
// data binds each sealed secret to its user and provider, so a ciphertext
// copied from one user's row to another's fails to open rather than lending
// one user's account to another.
package accounts

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Method is how a credential was obtained.
type Method string

const (
	APIKey Method = "api_key"
	OAuth  Method = "oauth"
)

// Connection is what may be shown about a stored credential.
type Connection struct {
	Provider    string    `json:"provider"`
	Method      Method    `json:"method"`
	Hint        string    `json:"hint"`
	ConnectedAt time.Time `json:"connectedAt"`
}

type record struct {
	User        string    `json:"user"`
	Provider    string    `json:"provider"`
	Method      Method    `json:"method"`
	Hint        string    `json:"hint"`
	ConnectedAt time.Time `json:"connectedAt"`
	Nonce       []byte    `json:"nonce"`
	Sealed      []byte    `json:"sealed"`
}

// ErrNotConnected is returned for a provider the user has not connected.
var ErrNotConnected = errors.New("not connected")

// Vault stores sealed credentials, in memory and, when a path is given, in a
// file that holds only ciphertext.
type Vault struct {
	mu      sync.Mutex
	aead    cipher.AEAD
	path    string
	records map[string]record
	now     func() time.Time
}

// Open makes a vault sealing under `key` (32 bytes), persisted at `path`, or
// in memory only when `path` is empty.
func Open(key []byte, path string) (*Vault, error) {
	if len(key) != 32 {
		return nil, fmt.Errorf("the vault key must be 32 bytes, not %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	v := &Vault{aead: aead, path: path, records: map[string]record{}, now: time.Now}
	if path == "" {
		return v, nil
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return nil, err
	}
	var rows []record
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, fmt.Errorf("vault %s: %w", path, err)
	}
	for _, r := range rows {
		v.records[id(r.User, r.Provider)] = r
	}
	return v, nil
}

func id(user, provider string) string { return user + "\x00" + provider }

func hint(secret string) string {
	if len(secret) <= 8 {
		return "…"
	}
	return "…" + secret[len(secret)-4:]
}

// Put stores (or replaces) a user's credential for a provider.
func (v *Vault) Put(user, provider string, method Method, secret string) error {
	if user == "" || provider == "" || secret == "" {
		return fmt.Errorf("a user, a provider and a credential are required")
	}
	nonce := make([]byte, v.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return err
	}
	r := record{
		User: user, Provider: provider, Method: method, Hint: hint(secret), ConnectedAt: v.now().UTC(),
		Nonce: nonce, Sealed: v.aead.Seal(nil, nonce, []byte(secret), []byte(id(user, provider))),
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.records[id(user, provider)] = r
	return v.save()
}

// Secret opens a user's credential for a provider, for the gateway's own use.
func (v *Vault) Secret(user, provider string) (string, error) {
	v.mu.Lock()
	r, ok := v.records[id(user, provider)]
	v.mu.Unlock()
	if !ok {
		return "", ErrNotConnected
	}
	plain, err := v.aead.Open(nil, r.Nonce, r.Sealed, []byte(id(user, provider)))
	if err != nil {
		return "", fmt.Errorf("the credential for %s cannot be opened: the vault key changed, or the row was not sealed for this user", provider)
	}
	return string(plain), nil
}

// Connections lists what a user has connected, without the secrets.
func (v *Vault) Connections(user string) map[string]Connection {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := map[string]Connection{}
	for _, r := range v.records {
		if r.User == user {
			out[r.Provider] = Connection{Provider: r.Provider, Method: r.Method, Hint: r.Hint, ConnectedAt: r.ConnectedAt}
		}
	}
	return out
}

// Delete disconnects a provider. The credential itself stays valid with the
// provider until the user revokes it there.
func (v *Vault) Delete(user, provider string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, ok := v.records[id(user, provider)]; !ok {
		return ErrNotConnected
	}
	delete(v.records, id(user, provider))
	return v.save()
}

// save writes every row, through a temporary file renamed into place, owner
// read-write only. Called with the lock held.
func (v *Vault) save() error {
	if v.path == "" {
		return nil
	}
	rows := make([]record, 0, len(v.records))
	for _, r := range v.records {
		rows = append(rows, r)
	}
	raw, err := json.MarshalIndent(rows, "", " ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(v.path), ".vault-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), v.path)
}
