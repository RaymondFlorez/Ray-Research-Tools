package sources

import (
	"fmt"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
)

// Reconcile decides what of a fresh load to append, given the versions the
// store already holds for the same keys.
//
// Loading a source twice must not rewrite the past. A source with vintages
// (EDGAR, ALFRED) gives every version its own knowledge time, and a reload
// brings back the same versions and maybe some new ones. A source without
// them (Treasury, Stooq) gives one version per date, stamped as of that date,
// and if the source corrected a value since the last load, the correction
// arrives stamped with the *original* knowledge time. Appended as it is, it
// would tie with the version already there and win, and a canvas scrubbed to
// any morning since would change. So:
//
//   - a version already held, same knowledge time and same value, is skipped;
//   - a version stamped no later than the latest one held for its period, with
//     a different value from that latest one, is a correction found now: it is
//     stamped with `now`, the load's own time, and marked a restatement;
//   - one with the same value as the latest held is skipped, since nothing
//     changed;
//   - anything else — a period not held, or a version known later than any
//     held — is appended as it is.
func Reconcile(existing, incoming []pit.Fact, now string) []pit.Fact {
	type period struct{ key, valid string }
	held := map[period][]pit.Fact{}
	for _, f := range existing {
		p := period{f.Key, f.ValidTime}
		held[p] = append(held[p], f)
	}
	latest := func(p period) (pit.Fact, bool) {
		vs := held[p]
		if len(vs) == 0 {
			return pit.Fact{}, false
		}
		best := vs[0]
		for _, v := range vs[1:] {
			if v.KnowledgeTime >= best.KnowledgeTime {
				best = v
			}
		}
		return best, true
	}
	var out []pit.Fact
	for _, f := range incoming {
		p := period{f.Key, f.ValidTime}
		dup := false
		for _, h := range held[p] {
			if h.KnowledgeTime == f.KnowledgeTime && h.Value == f.Value {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		if l, ok := latest(p); ok && f.KnowledgeTime <= l.KnowledgeTime {
			if f.Value == l.Value {
				continue
			}
			f.KnowledgeTime = now
			f.Restatement = true
			f.Source = fmt.Sprintf("%s (changed at the source; found on reload)", f.Source)
		}
		out = append(out, f)
		held[p] = append(held[p], f)
	}
	return out
}
