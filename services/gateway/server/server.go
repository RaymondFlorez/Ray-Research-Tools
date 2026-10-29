// Package server is the model gateway's HTTP API: which providers exist and
// which the caller has connected, connecting one by signing in or by API key,
// and a chat call to any model on a connected provider.
//
// Three rules, each enforced here rather than left to a caller:
//
//   - **A request names its data class, and placement decides who may see
//     it.** Positions and MNPI-risk content go only to providers the operator
//     marked self-hosted or on-device, never to a vendor's API — the routing
//     policy's hard rule (canvas-router), applied at the last point before the
//     data leaves. A request with no class is refused, not assumed public.
//   - **A caller never chooses where a request goes.** Providers and their
//     URLs are the operator's configuration; a request names a provider id.
//   - **A credential goes in and never comes out.** The API lists connections
//     with a hint and nothing more, and the audit log records who called which
//     model with what class of data, and never the content.
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/gateway/accounts"
	"github.com/raymondflorez/ray-research-tools/services/gateway/identity"
	"github.com/raymondflorez/ray-research-tools/services/gateway/provider"
)

// Placement is where a provider runs, which is what data sensitivity turns on.
type Placement string

const (
	OnDevice   Placement = "on_device"
	SelfHosted Placement = "self_hosted"
	Vendor     Placement = "vendor"
)

// Auth is how a user connects a provider.
type Auth string

const (
	// The user pastes an API key from their account with the provider.
	AuthAPIKey Auth = "api_key"
	// The user signs in with the provider, which hands back a key (OAuth with
	// PKCE, ending in a key exchange — OpenRouter's flow).
	AuthOAuth Auth = "oauth"
	// No credential: a server the operator runs, shared by every user.
	AuthNone Auth = "none"
)

// Provider is one entry of the operator's provider configuration.
type Provider struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Kind           string            `json:"kind"`
	BaseURL        string            `json:"baseUrl,omitempty"`
	MaxTokensField string            `json:"maxTokensField,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
	Placement      Placement         `json:"placement"`
	Auth           Auth              `json:"auth"`
	OAuth          *OAuthConfig      `json:"oauth,omitempty"`
	// Models, when set, is the only models a request may name; empty is any
	// model the provider serves.
	Models []string `json:"models,omitempty"`
	// Suggested models to offer in a picker. Not a restriction.
	Suggested []string `json:"suggested,omitempty"`
}

// OAuthConfig is a PKCE sign-in that ends in a key exchange.
type OAuthConfig struct {
	AuthorizeURL string `json:"authorizeUrl"`
	ExchangeURL  string `json:"exchangeUrl"`
}

// Validate checks one provider entry.
func (p Provider) Validate() error {
	switch {
	case p.ID == "" || strings.ContainsAny(p.ID, "/ ?#"):
		return fmt.Errorf("provider id %q", p.ID)
	case p.Kind != "anthropic" && p.Kind != "openai" && p.Kind != "gemini":
		return fmt.Errorf("provider %s: kind %q is not anthropic, openai or gemini", p.ID, p.Kind)
	case p.Kind == "openai" && p.BaseURL == "":
		return fmt.Errorf("provider %s: an openai-compatible provider needs a baseUrl", p.ID)
	case p.Placement != OnDevice && p.Placement != SelfHosted && p.Placement != Vendor:
		return fmt.Errorf("provider %s: placement %q", p.ID, p.Placement)
	case p.Auth != AuthAPIKey && p.Auth != AuthOAuth && p.Auth != AuthNone:
		return fmt.Errorf("provider %s: auth %q", p.ID, p.Auth)
	case p.Auth == AuthOAuth && (p.OAuth == nil || p.OAuth.AuthorizeURL == "" || p.OAuth.ExchangeURL == ""):
		return fmt.Errorf("provider %s: oauth needs authorizeUrl and exchangeUrl", p.ID)
	case p.Auth == AuthNone && p.Placement == Vendor:
		// A vendor reached with no user credential would be reached on the
		// operator's account, for every user, with nothing to say whose call it was.
		return fmt.Errorf("provider %s: a vendor provider needs a user credential", p.ID)
	}
	return nil
}

func (p Provider) adapter(client *http.Client) provider.Adapter {
	switch p.Kind {
	case "anthropic":
		return provider.Anthropic{BaseURL: p.BaseURL, Client: client}
	case "gemini":
		return provider.Gemini{BaseURL: p.BaseURL, Client: client}
	default:
		return provider.OpenAICompatible{Name: p.ID, BaseURL: p.BaseURL, MaxTokensField: p.MaxTokensField, Headers: p.Headers, Client: client}
	}
}

// classes a placement may receive: the routing policy's hard rule.
var allowed = map[Placement]map[string]bool{
	OnDevice:   {"public": true, "licensed": true, "positions": true, "mnpi_risk": true},
	SelfHosted: {"public": true, "licensed": true, "positions": true, "mnpi_risk": true},
	Vendor:     {"public": true, "licensed": true},
}

// AuditEntry is one dispatch, without its content.
type AuditEntry struct {
	At           time.Time `json:"at"`
	User         string    `json:"user"`
	Provider     string    `json:"provider"`
	Model        string    `json:"model"`
	DataClass    string    `json:"dataClass"`
	Outcome      string    `json:"outcome"`
	InputTokens  int64     `json:"inputTokens,omitempty"`
	OutputTokens int64     `json:"outputTokens,omitempty"`
}

// audit is append-only: no method removes or rewrites an entry, and reads
// hand out copies.
type audit struct {
	mu      sync.Mutex
	entries []AuditEntry
}

func (a *audit) add(e AuditEntry) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.entries = append(a.entries, e)
}

func (a *audit) of(user string) []AuditEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := []AuditEntry{}
	for _, e := range a.entries {
		if e.User == user {
			out = append(out, e)
		}
	}
	return out
}

type pending struct {
	user, provider, verifier string
	expires                  time.Time
}

// Server is the gateway.
type Server struct {
	providers map[string]Provider
	order     []string
	users     map[string]bool
	vault     *accounts.Vault
	client    *http.Client
	// PublicURL is where the browser reaches this gateway, for the OAuth
	// callback; ReturnURL is where a finished sign-in sends the browser.
	publicURL, returnURL string
	audit                *audit
	tenants              map[string]string
	identity             *identity.Verifier
	devIdentity          bool
	mu                   sync.Mutex
	pending              map[string]pending
	now                  func() time.Time
}

// Options configures a Server.
type Options struct {
	Providers []Provider
	Users     []string
	// Tenants is each user's tenant, which a session token must match.
	Tenants map[string]string
	// Identity verifies picasso-auth's session tokens; a token, when sent,
	// decides who is asking.
	Identity *identity.Verifier
	// DevIdentity accepts X-Picasso-User as the caller's name when no token is
	// sent. Off unless asked for: a name a client types is not an identity.
	DevIdentity          bool
	Vault                *accounts.Vault
	Client               *http.Client
	PublicURL, ReturnURL string
}

func New(o Options) (*Server, error) {
	s := &Server{
		providers: map[string]Provider{}, users: map[string]bool{}, vault: o.Vault, client: o.Client,
		publicURL: strings.TrimRight(o.PublicURL, "/"), returnURL: o.ReturnURL,
		audit: &audit{}, pending: map[string]pending{}, now: time.Now,
		tenants: o.Tenants, identity: o.Identity, devIdentity: o.DevIdentity,
	}
	if s.client == nil {
		s.client = &http.Client{Timeout: 5 * time.Minute}
	}
	if s.vault == nil {
		return nil, errors.New("a vault is required")
	}
	for _, p := range o.Providers {
		if err := p.Validate(); err != nil {
			return nil, err
		}
		if _, dup := s.providers[p.ID]; dup {
			return nil, fmt.Errorf("provider %s is configured twice", p.ID)
		}
		if p.Auth == AuthOAuth && (s.publicURL == "" || s.returnURL == "") {
			return nil, fmt.Errorf("provider %s signs in with OAuth, which needs the gateway's public URL and a return URL", p.ID)
		}
		s.providers[p.ID] = p
		s.order = append(s.order, p.ID)
	}
	for _, u := range o.Users {
		s.users[u] = true
	}
	return s, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, format string, args ...any) {
	writeJSON(w, status, map[string]string{"error": fmt.Sprintf(format, args...)})
}

// withUser resolves the caller from X-Picasso-User, the development stand-in
// for an identity provider that the data plane also uses.
func (s *Server) withUser(h func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, status, msg := s.caller(r)
		if status != 0 {
			fail(w, status, "%s", msg)
			return
		}
		h(w, r, user)
	}
}

// caller resolves who is asking: a verified session token, or, only when
// DevIdentity is on and no token was sent, the name in X-Picasso-User.
func (s *Server) caller(r *http.Request) (string, int, string) {
	if token := identity.Token(r); token != "" && s.identity != nil {
		session, refusal := s.identity.Verify(r.Context(), token)
		if refusal != nil {
			return "", http.StatusUnauthorized, "session: " + refusal.Error()
		}
		if !s.users[session.User] {
			return "", http.StatusUnauthorized, "unknown user"
		}
		if t := s.tenants[session.User]; t != "" && t != session.Tenant {
			return "", http.StatusForbidden, "the session is for another tenant"
		}
		return session.User, 0, ""
	}
	if s.devIdentity {
		if user := r.Header.Get("X-Picasso-User"); s.users[user] {
			return user, 0, ""
		}
		return "", http.StatusUnauthorized, "unknown user"
	}
	return "", http.StatusUnauthorized, "sign in: no session token"
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, http.StatusOK, map[string]bool{"ok": true}) })
	mux.HandleFunc("GET /v1/providers", s.withUser(s.listProviders))
	mux.HandleFunc("PUT /v1/accounts/{provider}", s.withUser(s.putKey))
	mux.HandleFunc("DELETE /v1/accounts/{provider}", s.withUser(s.disconnect))
	mux.HandleFunc("POST /v1/accounts/{provider}/oauth", s.withUser(s.startOAuth))
	mux.HandleFunc("GET /v1/oauth/callback", s.oauthCallback)
	mux.HandleFunc("POST /v1/chat", s.withUser(s.chat))
	mux.HandleFunc("GET /v1/audit", s.withUser(func(w http.ResponseWriter, _ *http.Request, user string) {
		writeJSON(w, http.StatusOK, map[string]any{"entries": s.audit.of(user)})
	}))
	return mux
}

type providerView struct {
	ID        string               `json:"id"`
	Name      string               `json:"name"`
	Kind      string               `json:"kind"`
	Placement Placement            `json:"placement"`
	Auth      Auth                 `json:"auth"`
	Accepts   []string             `json:"accepts"`
	Models    []string             `json:"models,omitempty"`
	Suggested []string             `json:"suggested,omitempty"`
	Connected bool                 `json:"connected"`
	Account   *accounts.Connection `json:"account,omitempty"`
}

func (s *Server) listProviders(w http.ResponseWriter, _ *http.Request, user string) {
	conns := s.vault.Connections(user)
	out := []providerView{}
	for _, id := range s.order {
		p := s.providers[id]
		v := providerView{ID: p.ID, Name: p.Name, Kind: p.Kind, Placement: p.Placement, Auth: p.Auth, Models: p.Models, Suggested: p.Suggested, Connected: p.Auth == AuthNone}
		for _, c := range []string{"public", "licensed", "positions", "mnpi_risk"} {
			if allowed[p.Placement][c] {
				v.Accepts = append(v.Accepts, c)
			}
		}
		if c, ok := conns[id]; ok {
			v.Connected, v.Account = true, &c
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, map[string]any{"providers": out})
}

func (s *Server) providerFor(w http.ResponseWriter, r *http.Request) (Provider, bool) {
	p, ok := s.providers[r.PathValue("provider")]
	if !ok {
		fail(w, http.StatusNotFound, "no provider %q is configured", r.PathValue("provider"))
	}
	return p, ok
}

func (s *Server) putKey(w http.ResponseWriter, r *http.Request, user string) {
	p, ok := s.providerFor(w, r)
	if !ok {
		return
	}
	if p.Auth != AuthAPIKey {
		fail(w, http.StatusBadRequest, "%s is not connected with an API key", p.Name)
		return
	}
	var body struct {
		APIKey string `json:"apiKey"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || strings.TrimSpace(body.APIKey) == "" {
		fail(w, http.StatusBadRequest, `body must be {"apiKey": "..."}`)
		return
	}
	if err := s.vault.Put(user, p.ID, accounts.APIKey, strings.TrimSpace(body.APIKey)); err != nil {
		fail(w, http.StatusInternalServerError, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, s.vault.Connections(user)[p.ID])
}

func (s *Server) disconnect(w http.ResponseWriter, r *http.Request, user string) {
	p, ok := s.providerFor(w, r)
	if !ok {
		return
	}
	if err := s.vault.Delete(user, p.ID); errors.Is(err, accounts.ErrNotConnected) {
		fail(w, http.StatusNotFound, "%s is not connected", p.Name)
		return
	} else if err != nil {
		fail(w, http.StatusInternalServerError, "%v", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"disconnected": p.ID, "note": "the credential still works with the provider until it is revoked there"})
}

func random(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

const signInWindow = 10 * time.Minute

// startOAuth begins a PKCE sign-in. The verifier and the user it belongs to
// stay here, keyed by an unguessable state that travels in the callback URL;
// the browser carries only the challenge.
func (s *Server) startOAuth(w http.ResponseWriter, r *http.Request, user string) {
	p, ok := s.providerFor(w, r)
	if !ok {
		return
	}
	if p.Auth != AuthOAuth {
		fail(w, http.StatusBadRequest, "%s does not offer sign-in here", p.Name)
		return
	}
	verifier, state := random(48), random(24)
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	s.mu.Lock()
	now := s.now()
	for k, v := range s.pending {
		if now.After(v.expires) {
			delete(s.pending, k)
		}
	}
	s.pending[state] = pending{user: user, provider: p.ID, verifier: verifier, expires: now.Add(signInWindow)}
	s.mu.Unlock()
	callback := s.publicURL + "/v1/oauth/callback?" + url.Values{"state": {state}}.Encode()
	authorize := p.OAuth.AuthorizeURL + "?" + url.Values{
		"callback_url": {callback}, "code_challenge": {challenge}, "code_challenge_method": {"S256"},
	}.Encode()
	writeJSON(w, http.StatusOK, map[string]string{"authorizeUrl": authorize})
}

// oauthCallback finishes a sign-in. It is reached by the browser's redirect
// from the provider, so it has no identity header: the state names the user,
// and works once.
func (s *Server) oauthCallback(w http.ResponseWriter, r *http.Request) {
	back := func(params url.Values) {
		http.Redirect(w, r, s.returnURL+"?"+params.Encode(), http.StatusSeeOther)
	}
	state, code := r.URL.Query().Get("state"), r.URL.Query().Get("code")
	s.mu.Lock()
	pend, ok := s.pending[state]
	delete(s.pending, state)
	s.mu.Unlock()
	if !ok || state == "" {
		back(url.Values{"error": {"this sign-in link has already been used or was never issued"}})
		return
	}
	if s.now().After(pend.expires) {
		back(url.Values{"error": {"the sign-in took longer than ten minutes; start it again"}, "provider": {pend.provider}})
		return
	}
	if code == "" {
		back(url.Values{"error": {"the provider returned no code; the sign-in was cancelled or refused"}, "provider": {pend.provider}})
		return
	}
	p := s.providers[pend.provider]
	key, err := s.exchange(r.Context(), p, code, pend.verifier)
	if err != nil {
		back(url.Values{"error": {err.Error()}, "provider": {p.ID}})
		return
	}
	if err := s.vault.Put(pend.user, p.ID, accounts.OAuth, key); err != nil {
		back(url.Values{"error": {"the key could not be stored"}, "provider": {p.ID}})
		return
	}
	back(url.Values{"connected": {p.ID}})
}

func (s *Server) exchange(ctx context.Context, p Provider, code, verifier string) (string, error) {
	body, _ := json.Marshal(map[string]string{"code": code, "code_verifier": verifier, "code_challenge_method": "S256"})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.OAuth.ExchangeURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := s.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("%s could not be reached to finish the sign-in", p.Name)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var out struct {
		Key string `json:"key"`
	}
	if res.StatusCode/100 != 2 || json.Unmarshal(raw, &out) != nil || out.Key == "" {
		return "", fmt.Errorf("%s refused the sign-in (%d)", p.Name, res.StatusCode)
	}
	return out.Key, nil
}

type chatRequest struct {
	Provider  string             `json:"provider"`
	Model     string             `json:"model"`
	System    string             `json:"system,omitempty"`
	Messages  []provider.Message `json:"messages"`
	MaxTokens int                `json:"maxTokens"`
	DataClass string             `json:"dataClass"`
}

func (s *Server) chat(w http.ResponseWriter, r *http.Request, user string) {
	var req chatRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, "body: %v", err)
		return
	}
	p, ok := s.providers[req.Provider]
	if !ok {
		fail(w, http.StatusNotFound, "no provider %q is configured", req.Provider)
		return
	}
	entry := AuditEntry{At: s.now().UTC(), User: user, Provider: p.ID, Model: req.Model, DataClass: req.DataClass}
	refuse := func(status int, format string, args ...any) {
		entry.Outcome = "refused: " + fmt.Sprintf(format, args...)
		s.audit.add(entry)
		fail(w, status, format, args...)
	}
	if _, known := allowed[OnDevice][req.DataClass]; !known {
		refuse(http.StatusBadRequest, "dataClass must be public, licensed, positions or mnpi_risk; a request with no class is not assumed public")
		return
	}
	if !allowed[p.Placement][req.DataClass] {
		refuse(http.StatusForbidden, "%s data may not go to %s, a vendor's API; use a self-hosted or on-device model", req.DataClass, p.Name)
		return
	}
	if len(p.Models) > 0 && !contains(p.Models, req.Model) {
		refuse(http.StatusForbidden, "%s is not among the models the operator allows on %s", req.Model, p.Name)
		return
	}
	preq := provider.Request{Model: req.Model, System: req.System, Messages: req.Messages, MaxTokens: req.MaxTokens}
	if err := preq.Validate(); err != nil {
		refuse(http.StatusBadRequest, "%v", err)
		return
	}
	credential := ""
	if p.Auth != AuthNone {
		var err error
		if credential, err = s.vault.Secret(user, p.ID); errors.Is(err, accounts.ErrNotConnected) {
			refuse(http.StatusPreconditionRequired, "connect %s first", p.Name)
			return
		} else if err != nil {
			refuse(http.StatusInternalServerError, "%v", err)
			return
		}
	}
	res, err := p.adapter(s.client).Chat(r.Context(), credential, preq)
	if err != nil {
		var perr *provider.Error
		if errors.As(err, &perr) {
			entry.Outcome = fmt.Sprintf("provider error %d", perr.Status)
		} else {
			entry.Outcome = "provider unreachable"
		}
		s.audit.add(entry)
		fail(w, http.StatusBadGateway, "%v", err)
		return
	}
	entry.Outcome, entry.InputTokens, entry.OutputTokens = string(res.Stop), res.InputTokens, res.OutputTokens
	s.audit.add(entry)
	writeJSON(w, http.StatusOK, map[string]any{"provider": p.ID, "response": res})
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
