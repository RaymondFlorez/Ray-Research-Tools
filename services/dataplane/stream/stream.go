// Package stream joins ingest to subscribers: decode, sequence, health, and a
// conflator per subscriber, with entitlements checked before anything is
// folded in (PRD 2.3's stream-ingest fan-out, 7.3's conflation).
//
// One conflator per subscriber rather than one shared: two analysts watching
// the same series may be on different subscriptions, drained at different
// times, and a subscriber that falls behind must not change what another one
// receives. Conflation bounds each at 4Hz per series however fast the feed
// runs, so the per-subscriber state is one pending update per series, not a
// queue.
package stream

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"sort"
	"sync"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/conflate"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/ingest"
)

// Hub receives raw messages and fans normalized, conflated updates out.
type Hub struct {
	sym     *ingest.Symbology
	seq     *ingest.Sequencer
	monitor *ingest.Monitor

	mu         sync.Mutex
	subs       map[*Subscription]struct{}
	rejections []ingest.Rejection
	gaps       []ingest.GapRange
	duplicates int
	accepted   int
}

func NewHub(sym *ingest.Symbology, staleAfter time.Duration) *Hub {
	return &Hub{
		sym:     sym,
		seq:     ingest.NewSequencer(),
		monitor: ingest.NewMonitor(staleAfter),
		subs:    map[*Subscription]struct{}{},
	}
}

// Ingest takes one raw message through the pipeline.
func (h *Hub) Ingest(raw ingest.Raw) {
	verdict, gap := h.seq.Observe(raw.Feed, raw.Channel, raw.Seq)
	h.mu.Lock()
	defer h.mu.Unlock()
	if verdict == ingest.Duplicate {
		h.duplicates++
		return
	}
	if gap != nil {
		h.gaps = append(h.gaps, *gap)
		h.monitor.GapOn(raw.Channel, *gap)
	}
	ev, rej := ingest.Decode(h.sym, raw)
	if rej != nil {
		h.rejections = append(h.rejections, *rej)
		return
	}
	h.accepted++
	h.monitor.Seen(ev.Instrument, ev.Channel, ev.ReceivedAt)
	values := make(map[string]float64, len(ev.Fields)+1)
	for k, v := range ev.Fields {
		values[k] = v
	}
	values["t_exchange"] = ev.ExchangeTime
	subject := ev.Subject()
	for s := range h.subs {
		s.offer(ev, subject, values)
	}
}

// Recovered clears a channel's gap once a snapshot has replaced what was missed.
func (h *Hub) Recovered(channel string) { h.monitor.Recovered(channel) }

// Run feeds an adapter through the hub until it stops.
func (h *Hub) Run(ctx context.Context, a ingest.Adapter) error {
	return a.Run(ctx, func(r ingest.Raw) error {
		h.Ingest(r)
		return nil
	})
}

// Counts are what the pipeline did, for the operator and the tests.
type Counts struct {
	Accepted   int                `json:"accepted"`
	Duplicates int                `json:"duplicates"`
	Rejections []ingest.Rejection `json:"rejections"`
	Gaps       []ingest.GapRange  `json:"gaps"`
}

func (h *Hub) Counts() Counts {
	h.mu.Lock()
	defer h.mu.Unlock()
	// Copies, and empty rather than null when there are none.
	return Counts{Accepted: h.accepted, Duplicates: h.duplicates, Rejections: append([]ingest.Rejection{}, h.rejections...), Gaps: append([]ingest.GapRange{}, h.gaps...)}
}

// Subscription is one client's view: subject patterns, entitlements, a conflator.
type Subscription struct {
	hub      *Hub
	patterns []string
	ent      entitle.Entitlements

	mu      sync.Mutex
	conf    *conflate.Conflator
	seen    map[string]bool
	blocked map[string]entitle.Decision
}

// Subscribe opens a subscription. Close it when the client goes.
func (h *Hub) Subscribe(patterns []string, ent entitle.Entitlements) *Subscription {
	s := &Subscription{hub: h, patterns: patterns, ent: ent, conf: conflate.New(conflate.Options{}), seen: map[string]bool{}, blocked: map[string]entitle.Decision{}}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	return s
}

func (s *Subscription) Close() {
	s.hub.mu.Lock()
	delete(s.hub.subs, s)
	s.hub.mu.Unlock()
}

func (s *Subscription) offer(ev ingest.Event, subject string, values map[string]float64) {
	matched := false
	for _, p := range s.patterns {
		if ingest.Match(p, subject) {
			matched = true
			break
		}
	}
	if !matched {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Checked per event, before folding: a licensed tick never enters the
	// conflator of a user who may not see it.
	if d := entitle.Check(ev.Class, ev.Vendor, s.ent); !d.Allowed {
		s.blocked[ev.Instrument] = d
		return
	}
	s.seen[ev.Instrument] = true
	vals := make(map[string]float64, len(values))
	for k, v := range values {
		vals[k] = v
	}
	s.conf.Accept(conflate.Tick{SeriesID: ev.Instrument, T: ev.ReceivedAt, Values: vals})
}

// Drain returns the updates due by now (ms).
func (s *Subscription) Drain(now float64) []conflate.Update {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conf.Drain(now)
}

// Blocked is every instrument the subscription matched and may not see.
func (s *Subscription) Blocked() map[string]entitle.Decision {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]entitle.Decision, len(s.blocked))
	for k, v := range s.blocked {
		out[k] = v
	}
	return out
}

// Health is the state of every instrument this subscription has received.
func (s *Subscription) Health(now float64) []ingest.Health {
	s.mu.Lock()
	ids := make([]string, 0, len(s.seen))
	for id := range s.seen {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	sort.Strings(ids)
	out := make([]ingest.Health, 0, len(ids))
	for _, id := range ids {
		out = append(out, s.hub.monitor.Check(id, now))
	}
	return out
}

// Recorded is one line of a recording: a raw message and its offset from the
// start of the recording.
type Recorded struct {
	Feed     string          `json:"feed"`
	Channel  string          `json:"channel"`
	Seq      uint64          `json:"seq"`
	OffsetMs float64         `json:"offsetMs"`
	Payload  json.RawMessage `json:"payload"`
}

// Replay is an adapter over a recording, for backfills and for tests. Speed 0
// replays as fast as it can; 1 at the recorded pace.
type Replay struct {
	Source io.Reader
	Speed  float64
	Clock  func() time.Time
}

func (r Replay) Name() string { return "replay" }

func (r Replay) Run(ctx context.Context, emit func(ingest.Raw) error) error {
	clock := r.Clock
	if clock == nil {
		clock = time.Now
	}
	start := clock()
	scan := bufio.NewScanner(r.Source)
	scan.Buffer(make([]byte, 1<<16), 1<<20)
	for scan.Scan() {
		if len(scan.Bytes()) == 0 {
			continue
		}
		var rec Recorded
		if err := json.Unmarshal(scan.Bytes(), &rec); err != nil {
			return err
		}
		if r.Speed > 0 {
			due := start.Add(time.Duration(rec.OffsetMs / r.Speed * float64(time.Millisecond)))
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Until(due)):
			}
		} else if ctx.Err() != nil {
			return ctx.Err()
		}
		raw := ingest.Raw{Feed: rec.Feed, Channel: rec.Channel, Seq: rec.Seq, Payload: rec.Payload, ReceivedAt: clock()}
		if r.Speed == 0 && r.Clock == nil {
			// As fast as possible: stamp receipt at the recorded offset, so
			// conflation windows are the recording's, not the replay's.
			raw.ReceivedAt = start.Add(time.Duration(rec.OffsetMs * float64(time.Millisecond)))
		}
		if err := emit(raw); err != nil {
			return err
		}
	}
	return scan.Err()
}
