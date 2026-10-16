// Package conflate folds a tick stream down to at most one update per series
// per window: PRD 7.3's "server-side conflation to 4Hz max per series", the
// step that turns 1.5M raw ticks a second into the 8,000 updates a browser
// subscribed to 2,000 series may receive.
//
// It is a port of canvas-data's `Conflator`, held to the same output, update
// for update and bit for bit, by the conformance file the TypeScript writes.
// The two decisions that make it more than "keep the last" are carried over
// unchanged: each field declares how it combines (a price is the last, a volume
// is a sum, a high a maximum, a low a minimum, an open the first), and each
// series is emitted on its own fixed grid anchored at its first tick, so phases
// spread across the window and the period cannot drift out to window + gap.
package conflate

import (
	"math"
	"sort"
)

// Combine is how a field folds when several ticks fall in one window.
type Combine string

const (
	Last  Combine = "last"
	First Combine = "first"
	Sum   Combine = "sum"
	Max   Combine = "max"
	Min   Combine = "min"
)

// FieldSpec says how each field of a series combines.
type FieldSpec map[string]Combine

// TradeFields is the default for a quoted instrument.
var TradeFields = FieldSpec{"price": Last, "size": Sum, "high": Max, "low": Min, "open": First}

// MaxHz is the PRD's per-series cap; WindowMs follows from it.
const (
	MaxHz    = 4
	WindowMs = 1000.0 / MaxHz
)

// Tick is one observation of one series. T is milliseconds since the epoch.
type Tick struct {
	SeriesID string
	T        float64
	Values   map[string]float64
}

// Update is what a subscriber receives: the folded window.
type Update struct {
	SeriesID string             `json:"seriesId"`
	T        float64            `json:"t"`
	Values   map[string]float64 `json:"values"`
	Ticks    int                `json:"ticks"`
}

type pending struct {
	update Update
	dueAt  float64
}

// Conflator holds one window per series. The caller owns the clock: Accept
// ticks as they arrive, Drain on a timer.
type Conflator struct {
	pending       map[string]*pending
	anchor        map[string]float64
	fields        map[string]FieldSpec
	defaultFields FieldSpec
	windowMs      float64
	accepted      int
	emitted       int
}

// Options configure per-series field semantics and the window.
type Options struct {
	Fields        map[string]FieldSpec
	DefaultFields FieldSpec
	WindowMs      float64
}

func New(o Options) *Conflator {
	c := &Conflator{
		pending:       map[string]*pending{},
		anchor:        map[string]float64{},
		fields:        o.Fields,
		defaultFields: o.DefaultFields,
		windowMs:      o.WindowMs,
	}
	if c.fields == nil {
		c.fields = map[string]FieldSpec{}
	}
	if c.defaultFields == nil {
		c.defaultFields = TradeFields
	}
	if c.windowMs == 0 {
		c.windowMs = WindowMs
	}
	return c
}

func (c *Conflator) spec(series string) FieldSpec {
	if s, ok := c.fields[series]; ok {
		return s
	}
	return c.defaultFields
}

// Accept folds one tick into its series' open window, opening one if none is.
func (c *Conflator) Accept(t Tick) {
	c.accepted++
	held, ok := c.pending[t.SeriesID]
	if !ok {
		anchor, seen := c.anchor[t.SeriesID]
		if !seen {
			anchor = t.T
			c.anchor[t.SeriesID] = anchor
		}
		slot := math.Floor((t.T-anchor)/c.windowMs) + 1
		values := make(map[string]float64, len(t.Values))
		for k, v := range t.Values {
			values[k] = v
		}
		c.pending[t.SeriesID] = &pending{
			update: Update{SeriesID: t.SeriesID, T: t.T, Values: values, Ticks: 1},
			dueAt:  anchor + slot*c.windowMs,
		}
		return
	}
	spec := c.spec(t.SeriesID)
	for field, v := range t.Values {
		prev, has := held.update.Values[field]
		if !has {
			held.update.Values[field] = v
			continue
		}
		switch spec[field] {
		case Sum:
			held.update.Values[field] = prev + v
		case Max:
			held.update.Values[field] = math.Max(prev, v)
		case Min:
			held.update.Values[field] = math.Min(prev, v)
		case First:
		default:
			held.update.Values[field] = v
		}
	}
	held.update.Ticks++
	// A late tick does not pull the window backwards.
	if t.T > held.update.T {
		held.update.T = t.T
	}
}

// Drain takes every series whose window has closed by now, oldest due first.
func (c *Conflator) Drain(now float64) []Update {
	var due []*pending
	for _, p := range c.pending {
		if p.dueAt <= now {
			due = append(due, p)
		}
	}
	sort.Slice(due, func(i, j int) bool {
		if due[i].dueAt != due[j].dueAt {
			return due[i].dueAt < due[j].dueAt
		}
		return due[i].update.SeriesID < due[j].update.SeriesID
	})
	out := make([]Update, 0, len(due))
	for _, p := range due {
		delete(c.pending, p.update.SeriesID)
		out = append(out, p.update)
	}
	c.emitted += len(out)
	return out
}

// Flush takes everything still held, for a shutdown.
func (c *Conflator) Flush() []Update {
	out := make([]Update, 0, len(c.pending))
	for _, p := range c.pending {
		out = append(out, p.update)
	}
	c.pending = map[string]*pending{}
	c.emitted += len(out)
	sort.Slice(out, func(i, j int) bool { return out[i].SeriesID < out[j].SeriesID })
	return out
}

// Stats are ticks in and updates out since construction.
func (c *Conflator) Stats() (accepted, emitted int) { return c.accepted, c.emitted }

// MaxUpdatesPerSecond is the fan-out bound: series times the per-series rate.
func MaxUpdatesPerSecond(series int) int { return series * MaxHz }
