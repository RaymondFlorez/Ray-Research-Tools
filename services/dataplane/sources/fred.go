package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
)

type alfredDoc struct {
	Observations []struct {
		RealtimeStart string `json:"realtime_start"`
		Date          string `json:"date"`
		Value         string `json:"value"`
	} `json:"observations"`
}

// ALFRED reads FRED's series observations over the full real-time period —
// every vintage — into facts `FRED.<series>`.
//
// Valid time is the observation date; knowledge time is the start of the next
// New York day after the vintage date (`realtime_start`). A vintage that
// repeats the value before it is not a new version; one that changes it is a
// restatement. "." is FRED's missing value and becomes no fact.
//
// ALFRED's history of a series begins at its first archived vintage, so values
// first released before that read as known only from it: late, not early.
//
// Many FRED series are published by third parties under their own terms. The
// class and vendor are the caller's to set; public is not assumed.
func ALFRED(body []byte, series string, class entitle.Class, vendor string) ([]pit.Fact, error) {
	if !class.Valid() || (class == entitle.Licensed && vendor == "") {
		return nil, fmt.Errorf("FRED %s: a class, and a vendor if licensed, are required", series)
	}
	var doc alfredDoc
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("FRED %s: %w", series, err)
	}
	obs := doc.Observations
	sort.SliceStable(obs, func(i, j int) bool {
		if obs[i].Date != obs[j].Date {
			return obs[i].Date < obs[j].Date
		}
		return obs[i].RealtimeStart < obs[j].RealtimeStart
	})
	var out []pit.Fact
	last := map[string]float64{}
	for _, o := range obs {
		if strings.TrimSpace(o.Value) == "." {
			continue
		}
		v, err := strconv.ParseFloat(o.Value, 64)
		if err != nil {
			return nil, fmt.Errorf("FRED %s %s: value %q", series, o.Date, o.Value)
		}
		prev, seen := last[o.Date]
		if seen && prev == v {
			continue
		}
		known, err := NextDayNewYork(o.RealtimeStart)
		if err != nil {
			return nil, fmt.Errorf("FRED %s %s: realtime_start: %w", series, o.Date, err)
		}
		out = append(out, pit.Fact{
			Key: "FRED." + series, ValidTime: o.Date, KnowledgeTime: known, Value: v,
			Source: "FRED/ALFRED " + series + " vintage " + o.RealtimeStart, Restatement: seen,
			Class: class, Vendor: vendor,
		})
		last[o.Date] = v
	}
	return out, nil
}

// FRED fetches from the St. Louis Fed's API with the operator's free key.
type FRED struct {
	Client *http.Client
	APIKey string
	Base   string
}

func (f FRED) Vintages(ctx context.Context, series string, class entitle.Class, vendor string) ([]pit.Fact, error) {
	if f.APIKey == "" {
		return nil, fmt.Errorf("FRED requires an API key (free, from fred.stlouisfed.org)")
	}
	base := f.Base
	if base == "" {
		base = "https://api.stlouisfed.org"
	}
	q := url.Values{
		"series_id": {series}, "api_key": {f.APIKey}, "file_type": {"json"},
		"realtime_start": {"1776-07-04"}, "realtime_end": {"9999-12-31"},
	}
	body, err := get(ctx, f.Client, base+"/fred/series/observations?"+q.Encode(), nil)
	if err != nil {
		// The key is in the URL; never repeat it in an error.
		return nil, fmt.Errorf("%s", strings.ReplaceAll(err.Error(), f.APIKey, "<key>"))
	}
	return ALFRED(body, series, class, vendor)
}
