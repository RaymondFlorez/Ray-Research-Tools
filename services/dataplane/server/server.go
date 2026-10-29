// Package server puts the data plane behind HTTP: point-in-time reads, and a
// live stream of conflated updates, both filtered by the caller's
// entitlements.
//
// Two deviations from PRD 2.3, stated rather than hidden:
//
//   - The stream is Server-Sent Events, JSON-encoded, not WebTransport with a
//     binary encoding. Every browser reads SSE with no library, and conflation
//     — the part that bounds the rate — is the same either way.
//   - Identity is a development stand-in: the caller names itself in a header
//     and its entitlements come from a file. PRD 7.2's OIDC is not built, so
//     this server must not face anything but a developer's machine.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/access"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/identity"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/stream"
)

// UserHeader names the caller when DevIdentity is set: a development
// stand-in for a session token, refused otherwise.
const UserHeader = "X-Picasso-User"

// Users resolves a caller to entitlements.
type Users map[string]entitle.Entitlements

// Server is the data plane's HTTP face.
type Server struct {
	Reader access.Reader
	Hub    *stream.Hub
	Users  Users
	// Writers may append facts. Reading is not writing: an analyst who can
	// see a series has no business adding versions of it.
	Writers map[string]bool
	// Feed names what feeds the stream, in the analyst's terms — "replay of
	// a recording", once there is one, a vendor's name. Shown as each tile's
	// source, so a replay is never mistaken for a market.
	Feed string
	// Drain and health cadence for streams; zero means 50ms and 1s.
	DrainEvery, HealthEvery time.Duration
	Now                     func() time.Time
	// Identity verifies picasso-auth's session tokens. A token, when one is
	// sent, decides who is asking.
	Identity *identity.Verifier
	// DevIdentity accepts UserHeader as the caller's name when no token is
	// sent. Off unless asked for: a name a client types is not an identity.
	DevIdentity bool
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok\n")) })
	mux.HandleFunc("GET /v1/asof", s.withUser(s.asOf))
	mux.HandleFunc("GET /v1/stream", s.withUser(s.stream))
	mux.HandleFunc("GET /v1/feed", s.withUser(func(w http.ResponseWriter, _ *http.Request, _ entitle.Entitlements) {
		feed := s.Feed
		if feed == "" {
			feed = "no feed connected"
		}
		writeJSON(w, http.StatusOK, map[string]string{"feed": feed})
	}))
	mux.HandleFunc("POST /v1/facts", s.withUser(s.appendFacts))
	mux.HandleFunc("GET /v1/history", s.withUser(s.history))
	mux.HandleFunc("GET /v1/versions", s.withUser(s.versions))
	mux.HandleFunc("GET /v1/counts", s.withUser(func(w http.ResponseWriter, _ *http.Request, _ entitle.Entitlements) {
		writeJSON(w, http.StatusOK, s.Hub.Counts())
	}))
	return mux
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) withUser(h func(http.ResponseWriter, *http.Request, entitle.Entitlements)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		e, status, msg := s.caller(r)
		if status != 0 {
			// Not an empty result: an unknown caller is refused outright.
			writeJSON(w, status, map[string]string{"error": msg})
			return
		}
		h(w, r, e)
	}
}

// caller resolves who is asking: a verified session token, or, only when
// DevIdentity is on and no token was sent, the name in UserHeader. A token's
// tenant must be the user's own; entitlements always come from this
// service's users file, never from the token.
func (s *Server) caller(r *http.Request) (entitle.Entitlements, int, string) {
	if token := identity.Token(r); token != "" && s.Identity != nil {
		session, refusal := s.Identity.Verify(r.Context(), token)
		if refusal != nil {
			return entitle.Entitlements{}, http.StatusUnauthorized, "session: " + refusal.Error()
		}
		e, ok := s.Users[session.User]
		if !ok {
			return entitle.Entitlements{}, http.StatusUnauthorized, "unknown user"
		}
		if e.TenantID != "" && e.TenantID != session.Tenant {
			return entitle.Entitlements{}, http.StatusForbidden, "the session is for another tenant"
		}
		return e, 0, ""
	}
	if s.DevIdentity {
		if e, ok := s.Users[r.Header.Get(UserHeader)]; ok {
			return e, 0, ""
		}
		return entitle.Entitlements{}, http.StatusUnauthorized, "unknown user"
	}
	return entitle.Entitlements{}, http.StatusUnauthorized, "sign in: no session token"
}

func (s *Server) asOf(w http.ResponseWriter, r *http.Request, e entitle.Entitlements) {
	q := r.URL.Query()
	query := pit.Query{Key: q.Get("key"), KnowledgeTime: q.Get("knowledge")}
	if query.Key == "" || query.KnowledgeTime == "" {
		// A read with no knowledge time would be a read of "now", and a
		// point-in-time API that defaults to now is how leakage gets in.
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key and knowledge are required"})
		return
	}
	if v := q.Get("from"); v != "" {
		query.From = &v
	}
	if v := q.Get("to"); v != "" {
		query.To = &v
	}
	res, err := s.Reader.AsOf(r.Context(), e, query)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// maxAppend bounds one append request's body.
const maxAppend = 8 << 20

func (s *Server) appendFacts(w http.ResponseWriter, r *http.Request, e entitle.Entitlements) {
	if !s.Writers[e.UserID] {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "this user may read, not append"})
		return
	}
	var facts []pit.Fact
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAppend))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&facts); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body must be a JSON array of facts: " + err.Error()})
		return
	}
	for _, f := range facts {
		if f.Key == "" || f.ValidTime == "" || f.KnowledgeTime == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "every fact needs a key, a valid time and a knowledge time"})
			return
		}
	}
	if err := s.Reader.Store.Append(r.Context(), facts...); err != nil {
		var unclassified pit.ErrUnclassified
		if errors.As(err, &unclassified) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"appended": len(facts)})
}

// HistoryEntry is one version of a fact, or the reason it is withheld.
type HistoryEntry struct {
	KnowledgeTime string            `json:"knowledgeTime"`
	Value         *float64          `json:"value,omitempty"`
	Restatement   bool              `json:"restatement,omitempty"`
	Source        string            `json:"source,omitempty"`
	Blocked       *entitle.Decision `json:"blocked,omitempty"`
}

func (s *Server) history(w http.ResponseWriter, r *http.Request, e entitle.Entitlements) {
	q := r.URL.Query()
	key, valid := q.Get("key"), q.Get("valid")
	if key == "" || valid == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key and valid are required"})
		return
	}
	facts, err := s.Reader.Store.History(r.Context(), key, valid)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := make([]HistoryEntry, 0, len(facts))
	for _, f := range facts {
		entry := HistoryEntry{KnowledgeTime: f.KnowledgeTime, Restatement: f.Restatement}
		// The same rule as a read: a version the caller may not see is
		// reported as withheld, with when it became known, and no value.
		if d := entitle.Check(f.Class, f.Vendor, e); d.Allowed {
			v := f.Value
			entry.Value = &v
			entry.Source = f.Source
		} else {
			entry.Blocked = &d
		}
		out = append(out, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": out})
}

// Version is one version of one fact, as a backtest loads it.
type Version struct {
	ValidTime     string  `json:"validTime"`
	KnowledgeTime string  `json:"knowledgeTime"`
	Value         float64 `json:"value"`
	Restatement   bool    `json:"restatement,omitempty"`
	Source        string  `json:"source,omitempty"`
}

// WithheldVersion is a version the caller may not see: when it was, and why.
type WithheldVersion struct {
	ValidTime     string           `json:"validTime"`
	KnowledgeTime string           `json:"knowledgeTime"`
	Decision      entitle.Decision `json:"decision"`
}

// versions returns every version in a valid-time range. The ones the caller
// may not see are listed separately, never dropped: a backtest that loaded the
// rest and carried on would use a superseded value on every bar after the
// withheld one, and look correct doing it.
func (s *Server) versions(w http.ResponseWriter, r *http.Request, e entitle.Entitlements) {
	q := r.URL.Query()
	key := q.Get("key")
	if key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key is required"})
		return
	}
	var from, to *string
	if v := q.Get("from"); v != "" {
		from = &v
	}
	if v := q.Get("to"); v != "" {
		to = &v
	}
	facts, err := s.Reader.Store.Versions(r.Context(), key, from, to)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	out := struct {
		Versions []Version         `json:"versions"`
		Withheld []WithheldVersion `json:"withheld"`
	}{Versions: []Version{}, Withheld: []WithheldVersion{}}
	for _, f := range facts {
		if d := entitle.Check(f.Class, f.Vendor, e); d.Allowed {
			out.Versions = append(out.Versions, Version{f.ValidTime, f.KnowledgeTime, f.Value, f.Restatement, f.Source})
		} else {
			out.Withheld = append(out.Withheld, WithheldVersion{f.ValidTime, f.KnowledgeTime, d})
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) stream(w http.ResponseWriter, r *http.Request, e entitle.Entitlements) {
	subjects := r.URL.Query()["subject"]
	if len(subjects) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at least one subject is required"})
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	sub := s.Hub.Subscribe(subjects, e)
	defer sub.Close()
	drainEvery, healthEvery := s.DrainEvery, s.HealthEvery
	if drainEvery == 0 {
		drainEvery = 50 * time.Millisecond
	}
	if healthEvery == 0 {
		healthEvery = time.Second
	}
	drain := time.NewTicker(drainEvery)
	health := time.NewTicker(healthEvery)
	defer drain.Stop()
	defer health.Stop()
	told := map[string]bool{}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-drain.C:
			now := float64(s.now().UnixMilli())
			for _, u := range sub.Drain(now) {
				send(w, "update", u)
			}
			blocked := sub.Blocked()
			ids := make([]string, 0, len(blocked))
			for id := range blocked {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, id := range ids {
				if !told[id] {
					told[id] = true
					send(w, "blocked", map[string]any{"instrument": id, "decision": blocked[id]})
				}
			}
			flusher.Flush()
		case <-health.C:
			send(w, "health", sub.Health(float64(s.now().UnixMilli())))
			flusher.Flush()
		}
	}
}

func send(w http.ResponseWriter, event string, payload any) {
	data, _ := json.Marshal(payload)
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
