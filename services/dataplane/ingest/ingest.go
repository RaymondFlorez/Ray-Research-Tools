// Package ingest is `stream-ingest` (PRD 2.3): vendor adapters, normalization,
// and the checks that stand between a feed and a number on a canvas.
//
// What is here is everything that does not depend on which vendor: the adapter
// interface, one canonical wire format and its decoder, symbology, sequence
// tracking, per-series health, subjects and partitioning. A vendor adapter is
// a decoder from that vendor's messages into Event, plus a connection; none is
// written, because which vendor is a decision this repository has not been
// given, and this environment's network policy refuses every market data host.
//
// Three rules, each enforced here rather than left to a caller:
//
//   - An unknown symbol is refused, not guessed. A feed that renames a ticker
//     should produce a counted rejection, not a new series that silently
//     shadows the old one.
//   - A sequence gap is reported, and every series on that channel is marked
//     recovering until the gap is filled or a snapshot replaces it. Missing
//     ticks are not visible in the ticks that did arrive.
//   - A series that stops updating is stale, with the time since its last
//     update. PRD 7.4: "tiles show last value with a stale-data badge and
//     elapsed time, never a silently frozen number."
package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"strings"
	"sync"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
)

// Raw is one message as a feed delivered it.
type Raw struct {
	Feed       string
	Channel    string
	Seq        uint64
	Payload    []byte
	ReceivedAt time.Time
}

// Adapter is a connection to one feed. Run blocks, emitting messages in the
// order the feed sent them, until ctx ends or the feed fails.
type Adapter interface {
	Name() string
	Run(ctx context.Context, emit func(Raw) error) error
}

// Event is a normalized observation of one instrument.
type Event struct {
	Feed       string
	Channel    string
	Seq        uint64
	Instrument string
	AssetClass string
	// Milliseconds since the epoch: when the venue stamped it, and when we got it.
	ExchangeTime float64
	ReceivedAt   float64
	Fields       map[string]float64
	Class        entitle.Class
	Vendor       string
}

// Subject is the NATS subject an event is published on: tick.<class>.<instrument>.
func (e Event) Subject() string { return Subject(e.AssetClass, e.Instrument) }

func Subject(assetClass, instrument string) string {
	return "tick." + assetClass + "." + instrument
}

// Match is NATS subject matching: `*` is one token, `>` is the rest (one or more).
func Match(pattern, subject string) bool {
	p := strings.Split(pattern, ".")
	s := strings.Split(subject, ".")
	for i, tok := range p {
		if tok == ">" {
			return i < len(s)
		}
		if i >= len(s) || (tok != "*" && tok != s[i]) {
			return false
		}
	}
	return len(p) == len(s)
}

// Partition is the Redpanda partition for an instrument: FNV-1a, so every
// event for one instrument lands in one partition, in order.
func Partition(instrument string, partitions int) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(instrument))
	return int(h.Sum32() % uint32(partitions))
}

// Symbology maps one feed's symbols to canonical instruments.
type Symbology struct {
	byFeed map[string]map[string]Instrument
}

// Instrument is a canonical id, its asset class, and how its data is licensed.
type Instrument struct {
	ID         string
	AssetClass string
	Class      entitle.Class
	Vendor     string
}

func NewSymbology() *Symbology { return &Symbology{byFeed: map[string]map[string]Instrument{}} }

// Map registers a feed symbol. A licensed instrument with no vendor is refused,
// for the reason entitle gives: nobody could be licensed for it.
func (s *Symbology) Map(feed, symbol string, inst Instrument) error {
	if !inst.Class.Valid() || (inst.Class == entitle.Licensed && inst.Vendor == "") {
		return fmt.Errorf("%s:%s carries no usable data class", feed, symbol)
	}
	if s.byFeed[feed] == nil {
		s.byFeed[feed] = map[string]Instrument{}
	}
	s.byFeed[feed][symbol] = inst
	return nil
}

func (s *Symbology) Lookup(feed, symbol string) (Instrument, bool) {
	inst, ok := s.byFeed[feed][symbol]
	return inst, ok
}

// Wire is the canonical message format: what a vendor adapter would translate
// into, and what the replay adapter reads.
type Wire struct {
	Symbol string             `json:"sym"`
	T      float64            `json:"t"`
	Fields map[string]float64 `json:"f"`
}

// Rejection says why a message did not become an event.
type Rejection struct {
	Feed, Channel string
	Seq           uint64
	Reason        string
}

// Decode turns a raw message in the canonical format into an event.
func Decode(sym *Symbology, raw Raw) (Event, *Rejection) {
	var w Wire
	if err := json.Unmarshal(raw.Payload, &w); err != nil {
		return Event{}, &Rejection{raw.Feed, raw.Channel, raw.Seq, "malformed: " + err.Error()}
	}
	inst, ok := sym.Lookup(raw.Feed, w.Symbol)
	if !ok {
		return Event{}, &Rejection{raw.Feed, raw.Channel, raw.Seq, "unknown symbol " + w.Symbol}
	}
	if len(w.Fields) == 0 {
		return Event{}, &Rejection{raw.Feed, raw.Channel, raw.Seq, "no fields"}
	}
	return Event{
		Feed: raw.Feed, Channel: raw.Channel, Seq: raw.Seq,
		Instrument: inst.ID, AssetClass: inst.AssetClass,
		ExchangeTime: w.T, ReceivedAt: float64(raw.ReceivedAt.UnixMilli()),
		Fields: w.Fields, Class: inst.Class, Vendor: inst.Vendor,
	}, nil
}

// Verdict is what the sequencer made of one message.
type Verdict int

const (
	InOrder Verdict = iota
	// Gap: messages between the last seen and this one never arrived.
	Gap
	// Duplicate: at or below the last seen; dropped.
	Duplicate
)

// GapRange is the run of sequence numbers that never arrived, inclusive.
type GapRange struct {
	Feed, Channel string
	From, To      uint64
}

// Sequencer tracks the last sequence number per feed channel.
type Sequencer struct {
	mu   sync.Mutex
	last map[string]uint64
}

func NewSequencer() *Sequencer { return &Sequencer{last: map[string]uint64{}} }

// Observe classifies one message. The first message on a channel sets the
// baseline. A gap advances the baseline — the missing range is reported once,
// not on every later message — and a duplicate leaves it alone.
func (s *Sequencer) Observe(feed, channel string, seq uint64) (Verdict, *GapRange) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := feed + "/" + channel
	last, seen := s.last[key]
	if !seen {
		s.last[key] = seq
		return InOrder, nil
	}
	switch {
	case seq <= last:
		return Duplicate, nil
	case seq == last+1:
		s.last[key] = seq
		return InOrder, nil
	default:
		s.last[key] = seq
		return Gap, &GapRange{Feed: feed, Channel: channel, From: last + 1, To: seq - 1}
	}
}

// State is a series' health, as a tile shows it.
type State string

const (
	Live State = "live"
	// Stale: no update within the threshold. The last value stays on screen, badged.
	Stale State = "stale"
	// Recovering: a gap on its channel has not been filled; the value may be wrong.
	Recovering State = "recovering"
)

// Health is one series' state and how long since it last updated.
type Health struct {
	Instrument string  `json:"instrument"`
	State      State   `json:"state"`
	LastUpdate float64 `json:"lastUpdate"`
	ElapsedMs  float64 `json:"elapsedMs"`
	Reason     string  `json:"reason,omitempty"`
}

// Monitor tracks per-series health against a staleness threshold.
type Monitor struct {
	mu         sync.Mutex
	threshold  float64
	last       map[string]float64
	channelOf  map[string]string
	recovering map[string]string // channel -> reason
}

func NewMonitor(staleAfter time.Duration) *Monitor {
	return &Monitor{
		threshold:  float64(staleAfter.Milliseconds()),
		last:       map[string]float64{},
		channelOf:  map[string]string{},
		recovering: map[string]string{},
	}
}

// Seen records an update to an instrument at `at` (ms), on a channel.
func (m *Monitor) Seen(instrument, channel string, at float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.last[instrument] = at
	m.channelOf[instrument] = channel
}

// GapOn marks every series on a channel recovering, until Recovered.
func (m *Monitor) GapOn(channel string, g GapRange) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.recovering[channel] = fmt.Sprintf("sequence gap %d-%d on %s", g.From, g.To, channel)
}

// Recovered clears a channel's gap: a snapshot replaced what was missed.
func (m *Monitor) Recovered(channel string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.recovering, channel)
}

// Check reports one series' health at `now` (ms).
func (m *Monitor) Check(instrument string, now float64) Health {
	m.mu.Lock()
	defer m.mu.Unlock()
	last, ok := m.last[instrument]
	if !ok {
		return Health{Instrument: instrument, State: Stale, Reason: "no update received"}
	}
	h := Health{Instrument: instrument, LastUpdate: last, ElapsedMs: now - last, State: Live}
	if reason, gap := m.recovering[m.channelOf[instrument]]; gap {
		h.State = Recovering
		h.Reason = reason
	} else if now-last > m.threshold {
		h.State = Stale
		h.Reason = "no update within the staleness threshold"
	}
	return h
}
