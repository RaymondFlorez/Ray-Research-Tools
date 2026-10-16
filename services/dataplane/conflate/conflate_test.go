package conflate

import (
	"math"
	"reflect"
	"testing"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/internal/contract"
)

func toSpec(m map[string]string) FieldSpec {
	s := FieldSpec{}
	for k, v := range m {
		s[k] = Combine(v)
	}
	return s
}

func same(t *testing.T, label string, got []Update, want []contract.Update) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %d updates, want %d", label, len(got), len(want))
	}
	for i := range got {
		w := want[i]
		g := got[i]
		if g.SeriesID != w.SeriesID || g.T != w.T || g.Ticks != w.Ticks || !reflect.DeepEqual(g.Values, w.Values) {
			t.Fatalf("%s, update %d: got %+v, want %+v", label, i, g, w)
		}
		for k, v := range g.Values {
			if math.Float64bits(v) != math.Float64bits(w.Values[k]) {
				t.Fatalf("%s, update %d, %s: bits differ", label, i, k)
			}
		}
	}
}

// The TypeScript's updates, drain for drain, to the bit.
func TestMatchesTheTypeScript(t *testing.T) {
	f, err := contract.Load()
	if err != nil {
		t.Fatal(err)
	}
	cf := f.Conflation
	fields := map[string]FieldSpec{}
	for series, spec := range cf.Fields {
		fields[series] = toSpec(spec)
	}
	c := New(Options{Fields: fields, DefaultFields: toSpec(cf.DefaultFields), WindowMs: cf.WindowMs})
	expected := map[float64][]contract.Update{}
	for _, d := range cf.Drains {
		expected[d.Now] = d.Updates
	}
	i := 0
	for _, now := range cf.DrainTimes {
		for i < len(cf.Ticks) && cf.Ticks[i].T <= now {
			tk := cf.Ticks[i]
			c.Accept(Tick{SeriesID: tk.SeriesID, T: tk.T, Values: tk.Values})
			i++
		}
		same(t, "drain", c.Drain(now), expected[now])
	}
	same(t, "flush", c.Flush(), cf.Flushed)
	if a, e := c.Stats(); a != cf.Stats.Accepted || e != cf.Stats.Emitted {
		t.Fatalf("stats %d/%d, want %d/%d", a, e, cf.Stats.Accepted, cf.Stats.Emitted)
	}
}

// The PRD's bound: whatever the input rate, a series emits at most 4 times a second.
func TestNoSeriesExceedsTheCap(t *testing.T) {
	c := New(Options{})
	var updates int
	for ms := 0.0; ms < 10_000; ms++ { // 1kHz for ten seconds
		c.Accept(Tick{SeriesID: "NVDA", T: ms, Values: map[string]float64{"price": ms, "size": 1}})
		updates += len(c.Drain(ms))
	}
	if updates > 40 || updates < 39 {
		t.Fatalf("%d updates in 10s at 1kHz; the cap is 40 and the grid should not lose any", updates)
	}
}
