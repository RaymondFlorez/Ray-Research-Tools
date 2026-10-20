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
	"fmt"
	"net/http"
	"sort"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/access"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/stream"
)

// UserHeader names the caller. Development only; see the package comment.
const UserHeader = "X-Picasso-User"

// Users resolves a caller to entitlements.
type Users map[string]entitle.Entitlements

// Server is the data plane's HTTP face.
type Server struct {
	Reader access.Reader
	Hub    *stream.Hub
	Users  Users
	// Feed names what feeds the stream, in the analyst's terms — "replay of
	// a recording", once there is one, a vendor's name. Shown as each tile's
	// source, so a replay is never mistaken for a market.
	Feed string
	// Drain and health cadence for streams; zero means 50ms and 1s.
	DrainEvery, HealthEvery time.Duration
	Now                     func() time.Time
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
		e, ok := s.Users[r.Header.Get(UserHeader)]
		if !ok {
			// Not an empty result: an unknown caller is refused outright.
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unknown user"})
			return
		}
		h(w, r, e)
	}
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
