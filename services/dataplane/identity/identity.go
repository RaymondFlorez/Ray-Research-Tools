// Package identity verifies picasso-auth's session tokens (services/auth).
//
// A request names its user with a token picasso-auth signed, not with a
// header it typed: an Ed25519 JWT, fifteen minutes long, verified here
// against the key picasso-auth publishes at /.well-known/jwks.json. The
// verdicts are held to the TypeScript verifier's by a shared file,
// services/auth/testdata/tokens.json, which the tests read; services/gateway
// carries the same package and the same test.
//
// Verification is go-jose's. What this adds is what it leaves to the caller:
// one algorithm, EdDSA, and nothing else accepted; the issuer and the
// audience; and the fifteen-minute ceiling, checked on the token rather than
// assumed of the issuer.
//
// Logout reaches this service through the list of ended sessions
// picasso-auth publishes at /auth/revoked, re-read at most every
// RevocationRefresh. A verifier that has not read it for RevocationMaxStale
// refuses every token: it cannot tell a logged-out session from a live one.
package identity

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

// Audience is what every session token is for.
const Audience = "picasso"

// Leeway is the clock skew tolerated, both ways.
const Leeway = 30 * time.Second

// MaxLifetime is PRD 7.2's fifteen minutes.
const MaxLifetime = 15 * time.Minute

// RevocationRefresh is how often the list of logged-out sessions is re-read,
// and so how long a logout can take to reach this service.
const RevocationRefresh = 5 * time.Second

// RevocationMaxStale is how old the list may get before every token is refused.
const RevocationMaxStale = 30 * time.Second

// Cookie is where a browser carries the token; a WebSocket cannot set a header.
const Cookie = "picasso_session"

// Session is who a verified token says is asking.
type Session struct {
	User, Tenant, SID string
	Expires           time.Time
}

// Refusal is why a token was not accepted; the names are the TypeScript verifier's.
type Refusal struct {
	Reason  string
	Message string
}

func (r *Refusal) Error() string { return r.Reason + ": " + r.Message }

func refuse(reason, format string, args ...any) *Refusal {
	return &Refusal{Reason: reason, Message: fmt.Sprintf(format, args...)}
}

// Verifier checks tokens against a key set: a fixed one, or picasso-auth's,
// fetched and refreshed when a token names a key it does not have.
type Verifier struct {
	Issuer  string
	JWKSURL string
	// RevokedURL is picasso-auth's list of logged-out sessions. Empty for a
	// static verifier, whose list is only what Revoke adds.
	RevokedURL string
	Client     *http.Client
	Now        func() time.Time

	mu      sync.Mutex
	keys    jose.JSONWebKeySet
	fetched time.Time

	revMu      sync.Mutex
	revoked    map[string]bool
	revRead    time.Time // the last successful read
	revAttempt time.Time
}

// Static is a verifier over a key set that never changes.
func Static(issuer string, keys jose.JSONWebKeySet) *Verifier {
	return &Verifier{Issuer: issuer, keys: keys, fetched: time.Now(), revoked: map[string]bool{}}
}

// Remote is a verifier that reads picasso-auth's published keys and its list
// of logged-out sessions.
func Remote(authURL string) *Verifier {
	base := strings.TrimRight(authURL, "/")
	return &Verifier{Issuer: base, JWKSURL: base + "/.well-known/jwks.json", RevokedURL: base + "/auth/revoked", Client: &http.Client{Timeout: 10 * time.Second}}
}

// Revoke adds sessions to a static verifier's list.
func (v *Verifier) Revoke(sids ...string) {
	v.revMu.Lock()
	defer v.revMu.Unlock()
	if v.revoked == nil {
		v.revoked = map[string]bool{}
	}
	for _, s := range sids {
		v.revoked[s] = true
	}
}

// revocation decides whether a session was logged out, re-reading the list
// when it is older than RevocationRefresh, and refusing when no read has
// succeeded within RevocationMaxStale.
func (v *Verifier) revocation(ctx context.Context, sid string) *Refusal {
	v.revMu.Lock()
	defer v.revMu.Unlock()
	if v.RevokedURL != "" {
		now := v.now()
		if now.Sub(v.revAttempt) >= RevocationRefresh {
			v.revAttempt = now
			if sids, err := v.readRevoked(ctx); err == nil {
				v.revoked, v.revRead = sids, v.now()
			}
		}
		if v.revRead.IsZero() || v.now().Sub(v.revRead) > RevocationMaxStale {
			return refuse("revocation_unknown", "this service cannot reach picasso-auth's list of logged-out sessions")
		}
	}
	if v.revoked[sid] {
		return refuse("revoked", "this session was logged out")
	}
	return nil
}

func (v *Verifier) readRevoked(ctx context.Context) (map[string]bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.RevokedURL, nil)
	if err != nil {
		return nil, err
	}
	res, err := v.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var body struct {
		SIDs []string `json:"sids"`
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode != http.StatusOK || json.Unmarshal(raw, &body) != nil || body.SIDs == nil {
		return nil, fmt.Errorf("picasso-auth's revocation list: %s", res.Status)
	}
	out := make(map[string]bool, len(body.SIDs))
	for _, s := range body.SIDs {
		out[s] = true
	}
	return out, nil
}

func (v *Verifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

// key finds a key by id, fetching the set again if it is unknown, at most
// every thirty seconds, so a stream of tokens under a bogus kid cannot make
// this service hammer picasso-auth.
func (v *Verifier) key(ctx context.Context, kid string) (*jose.JSONWebKey, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if ks := v.keys.Key(kid); len(ks) > 0 {
		return &ks[0], nil
	}
	if v.JWKSURL == "" || time.Since(v.fetched) < 30*time.Second {
		return nil, errors.New("no key with that id")
	}
	v.fetched = time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.JWKSURL, nil)
	if err != nil {
		return nil, err
	}
	res, err := v.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("picasso-auth's keys: %w", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var set jose.JSONWebKeySet
	if res.StatusCode != http.StatusOK || json.Unmarshal(raw, &set) != nil {
		return nil, fmt.Errorf("picasso-auth's keys: %s", res.Status)
	}
	v.keys = set
	if ks := v.keys.Key(kid); len(ks) > 0 {
		return &ks[0], nil
	}
	return nil, errors.New("no key with that id")
}

type private struct {
	Tenant string `json:"tenant"`
	SID    string `json:"sid"`
}

// Verify decides one token.
func (v *Verifier) Verify(ctx context.Context, token string) (Session, *Refusal) {
	tok, err := jwt.ParseSigned(token, []jose.SignatureAlgorithm{jose.EdDSA})
	if err != nil {
		if strings.Contains(err.Error(), "algorithm") {
			return Session{}, refuse("unsupported_alg", "%v", err)
		}
		return Session{}, refuse("malformed", "%v", err)
	}
	if len(tok.Headers) != 1 {
		return Session{}, refuse("malformed", "one signature expected")
	}
	key, err := v.key(ctx, tok.Headers[0].KeyID)
	if err != nil {
		return Session{}, refuse("invalid_signature", "%v", err)
	}
	var std jwt.Claims
	var p private
	if err := tok.Claims(key.Key, &std, &p); err != nil {
		return Session{}, refuse("invalid_signature", "%v", err)
	}
	if err := std.ValidateWithLeeway(jwt.Expected{Issuer: v.Issuer, AnyAudience: jwt.Audience{Audience}, Time: v.now()}, Leeway); err != nil {
		switch {
		case errors.Is(err, jwt.ErrInvalidIssuer):
			return Session{}, refuse("wrong_issuer", "%v", err)
		case errors.Is(err, jwt.ErrInvalidAudience):
			return Session{}, refuse("wrong_audience", "%v", err)
		case errors.Is(err, jwt.ErrExpired):
			return Session{}, refuse("expired", "%v", err)
		case errors.Is(err, jwt.ErrNotValidYet), errors.Is(err, jwt.ErrIssuedInTheFuture):
			return Session{}, refuse("not_yet_valid", "%v", err)
		}
		return Session{}, refuse("malformed", "%v", err)
	}
	if std.IssuedAt == nil || std.Expiry == nil || std.Subject == "" || p.Tenant == "" || p.SID == "" {
		return Session{}, refuse("malformed", "a session token names its subject, tenant, session, and when it was issued and expires")
	}
	if life := std.Expiry.Time().Sub(std.IssuedAt.Time()); life > MaxLifetime {
		return Session{}, refuse("lifetime_too_long", "the token lives %d minutes against a limit of 15", int(life.Minutes()))
	}
	if r := v.revocation(ctx, p.SID); r != nil {
		return Session{}, r
	}
	return Session{User: std.Subject, Tenant: p.Tenant, SID: p.SID, Expires: std.Expiry.Time()}, nil
}

// Token reads a request's session token: the Authorization header, or the
// session cookie a browser sends with a WebSocket or a same-site request.
func Token(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	if c, err := r.Cookie(Cookie); err == nil {
		return c.Value
	}
	return ""
}
