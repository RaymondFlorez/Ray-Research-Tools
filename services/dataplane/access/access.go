// Package access is `data-access` (PRD 2.3): point-in-time reads, filtered by
// entitlement, the only way a canvas reads the store.
//
// The rule that shapes it: "nodes render an entitlement-blocked state rather
// than a stale cached value when a user lacks rights" (PRD 7.2). So a value the
// user may not see is reported as blocked, with the reason — it is never
// replaced by an older version of the same fact that they happen to be allowed,
// which would be a stale number shown as current.
package access

import (
	"context"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
)

// Blocked is a valid time the user may not see, and why.
type Blocked struct {
	ValidTime string           `json:"validTime"`
	Decision  entitle.Decision `json:"decision"`
}

// Result is what one read returns: the observations the user may see, and the
// ones withheld.
type Result struct {
	Observations []pit.Observation `json:"observations"`
	Blocked      []Blocked         `json:"blocked"`
}

// Reader reads through one store.
type Reader struct{ Store pit.Store }

// AsOf reads as of the query's knowledge time, then withholds what the user may not see.
// AsOfMany is AsOf for many keys at one knowledge time, in one store call.
func (r Reader) AsOfMany(ctx context.Context, e entitle.Entitlements, keys []string, knowledgeTime string) (map[string]Result, error) {
	all, err := r.Store.AsOfMany(ctx, keys, knowledgeTime)
	if err != nil {
		return nil, err
	}
	out := make(map[string]Result, len(all))
	for key, obs := range all {
		res := Result{Observations: []pit.Observation{}, Blocked: []Blocked{}}
		for _, o := range obs {
			if d := entitle.Check(o.Class, o.Vendor, e); d.Allowed {
				res.Observations = append(res.Observations, o)
			} else {
				res.Blocked = append(res.Blocked, Blocked{ValidTime: o.ValidTime, Decision: d})
			}
		}
		out[key] = res
	}
	return out, nil
}

func (r Reader) AsOf(ctx context.Context, e entitle.Entitlements, q pit.Query) (Result, error) {
	all, err := r.Store.AsOf(ctx, q)
	if err != nil {
		return Result{}, err
	}
	res := Result{Observations: []pit.Observation{}, Blocked: []Blocked{}}
	for _, o := range all {
		if d := entitle.Check(o.Class, o.Vendor, e); d.Allowed {
			res.Observations = append(res.Observations, o)
		} else {
			res.Blocked = append(res.Blocked, Blocked{ValidTime: o.ValidTime, Decision: d})
		}
	}
	return res, nil
}
