// Package pit is the point-in-time store `data-access` reads through
// (PRD 5.8): "a backtest at date T cannot see any record whose knowledge-time
// exceeds T."
//
// Two clocks. Valid time is what a fact is about; knowledge time is when it
// became known. For each valid time, a read as of T returns the latest version
// known at or before T, and of two versions known at the same instant the one
// appended later. Records are never edited or deleted: a correction is a new
// record with a later knowledge time, which is what makes a historical read
// reproducible forever.
//
// These are canvas-data's `BitemporalStore` semantics, and the conformance
// file holds both stores here — in memory and on Postgres — to the TypeScript's
// answers. Instants are ISO-8601 strings compared byte for byte, as the
// TypeScript compares them, so the Postgres columns are text with the "C"
// collation rather than timestamps: a timestamp column would order a bare date
// and a midnight instant as equal, and the TypeScript does not.
package pit

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
)

// Fact is one version of one fact. Class is required: PRD 7.2 has the data
// layer stamp every record, so a fact with no class is refused at append.
type Fact struct {
	Key           string        `json:"key"`
	ValidTime     string        `json:"validTime"`
	KnowledgeTime string        `json:"knowledgeTime"`
	Value         float64       `json:"value"`
	Source        string        `json:"source,omitempty"`
	Restatement   bool          `json:"restatement,omitempty"`
	Class         entitle.Class `json:"dataClass"`
	Vendor        string        `json:"vendor,omitempty"`
}

// Query is an as-of read: one key, as known at KnowledgeTime, optionally
// bounded in valid time (both bounds inclusive).
type Query struct {
	Key           string
	KnowledgeTime string
	From, To      *string
}

// Observation is the value in force for one valid time, and when it became known.
type Observation struct {
	ValidTime string        `json:"validTime"`
	Value     float64       `json:"value"`
	KnownAt   string        `json:"knownAt"`
	Source    string        `json:"source,omitempty"`
	Class     entitle.Class `json:"dataClass"`
	Vendor    string        `json:"vendor,omitempty"`
}

// Store is the point-in-time store. There is no update and no delete.
type Store interface {
	Append(ctx context.Context, facts ...Fact) error
	AsOf(ctx context.Context, q Query) ([]Observation, error)
	History(ctx context.Context, key, validTime string) ([]Fact, error)
	// Versions is every version of every fact for key with a valid time in
	// [from, to] (nil is unbounded), by valid time, knowledge time, then
	// append order: what a backtest loads.
	Versions(ctx context.Context, key string, from, to *string) ([]Fact, error)
}

// ErrUnclassified is returned for a fact with no valid class, or a licensed
// fact with no vendor.
type ErrUnclassified struct{ Key string }

func (e ErrUnclassified) Error() string {
	return fmt.Sprintf("fact %q carries no data class (or is licensed with no vendor); the data layer stamps every record", e.Key)
}

func validate(f Fact) error {
	if !f.Class.Valid() || (f.Class == entitle.Licensed && f.Vendor == "") {
		return ErrUnclassified{Key: f.Key}
	}
	return nil
}

// Memory is the in-process store, for tests and for the browser's twin.
type Memory struct {
	mu    sync.RWMutex
	facts map[string][]Fact
}

func NewMemory() *Memory { return &Memory{facts: map[string][]Fact{}} }

func (m *Memory) Append(_ context.Context, facts ...Fact) error {
	for _, f := range facts {
		if err := validate(f); err != nil {
			return err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, f := range facts {
		m.facts[f.Key] = append(m.facts[f.Key], f)
	}
	return nil
}

func (m *Memory) AsOf(_ context.Context, q Query) ([]Observation, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	latest := map[string]Fact{}
	for _, f := range m.facts[q.Key] {
		if f.KnowledgeTime > q.KnowledgeTime {
			continue
		}
		if q.From != nil && f.ValidTime < *q.From {
			continue
		}
		if q.To != nil && f.ValidTime > *q.To {
			continue
		}
		// Appends are in order, so >= keeps the later of two at the same instant.
		if held, ok := latest[f.ValidTime]; !ok || f.KnowledgeTime >= held.KnowledgeTime {
			latest[f.ValidTime] = f
		}
	}
	out := make([]Observation, 0, len(latest))
	for _, f := range latest {
		out = append(out, Observation{ValidTime: f.ValidTime, Value: f.Value, KnownAt: f.KnowledgeTime, Source: f.Source, Class: f.Class, Vendor: f.Vendor})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ValidTime < out[j].ValidTime })
	return out, nil
}

func (m *Memory) Versions(_ context.Context, key string, from, to *string) ([]Fact, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []Fact
	for _, f := range m.facts[key] {
		if (from != nil && f.ValidTime < *from) || (to != nil && f.ValidTime > *to) {
			continue
		}
		out = append(out, f)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].ValidTime != out[j].ValidTime {
			return out[i].ValidTime < out[j].ValidTime
		}
		return out[i].KnowledgeTime < out[j].KnowledgeTime
	})
	return out, nil
}

func (m *Memory) History(_ context.Context, key, validTime string) ([]Fact, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []Fact
	for _, f := range m.facts[key] {
		if f.ValidTime == validTime {
			out = append(out, f)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].KnowledgeTime < out[j].KnowledgeTime })
	return out, nil
}
