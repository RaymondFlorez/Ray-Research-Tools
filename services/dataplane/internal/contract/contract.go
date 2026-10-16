// Package contract loads the conformance file the TypeScript side writes
// (packages/canvas-data/test/conformance.test.ts): the cases both
// implementations of the data plane's rules must answer identically.
package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

// Fact mirrors canvas-data's `Fact<number>`.
type Fact struct {
	Key           string  `json:"key"`
	ValidTime     string  `json:"validTime"`
	KnowledgeTime string  `json:"knowledgeTime"`
	Value         float64 `json:"value"`
	Source        string  `json:"source,omitempty"`
	Restatement   bool    `json:"restatement,omitempty"`
}

// Query mirrors `AsOfQuery`.
type Query struct {
	Key           string  `json:"key"`
	KnowledgeTime string  `json:"knowledgeTime"`
	From          *string `json:"from,omitempty"`
	To            *string `json:"to,omitempty"`
}

// Observation mirrors `Observation<number>`.
type Observation struct {
	ValidTime string  `json:"validTime"`
	Value     float64 `json:"value"`
	KnownAt   string  `json:"knownAt"`
	Source    string  `json:"source,omitempty"`
}

type Tick struct {
	SeriesID string             `json:"seriesId"`
	T        float64            `json:"t"`
	Values   map[string]float64 `json:"values"`
}

type Update struct {
	SeriesID string             `json:"seriesId"`
	T        float64            `json:"t"`
	Values   map[string]float64 `json:"values"`
	Ticks    int                `json:"ticks"`
}

type Record struct {
	ID        string `json:"id"`
	DataClass string `json:"dataClass"`
	Vendor    string `json:"vendor,omitempty"`
}

type User struct {
	UserID    string   `json:"userId"`
	TenantID  string   `json:"tenantId"`
	Vendors   []string `json:"vendors"`
	Positions bool     `json:"positions"`
	MNPI      bool     `json:"mnpi"`
}

type Decision struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

type File struct {
	PointInTime struct {
		Facts []Fact `json:"facts"`
		AsOf  []struct {
			Query    Query         `json:"query"`
			Expected []Observation `json:"expected"`
		} `json:"asOf"`
		History []struct {
			Key       string `json:"key"`
			ValidTime string `json:"validTime"`
			Expected  []Fact `json:"expected"`
		} `json:"history"`
	} `json:"pointInTime"`
	Conflation struct {
		WindowMs      float64                      `json:"windowMs"`
		DefaultFields map[string]string            `json:"defaultFields"`
		Fields        map[string]map[string]string `json:"fields"`
		Ticks         []Tick                       `json:"ticks"`
		Drains        []struct {
			Now     float64  `json:"now"`
			Updates []Update `json:"updates"`
		} `json:"drains"`
		DrainTimes []float64 `json:"drainTimes"`
		Flushed    []Update  `json:"flushed"`
		Stats      struct {
			Accepted int `json:"accepted"`
			Emitted  int `json:"emitted"`
		} `json:"stats"`
	} `json:"conflation"`
	Entitlements []struct {
		User     User     `json:"user"`
		Record   Record   `json:"record"`
		Expected Decision `json:"expected"`
	} `json:"entitlements"`
}

// Load reads testdata/conformance.json relative to this module.
func Load() (*File, error) {
	_, here, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(here), "..", "..", "testdata", "conformance.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f File
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, err
	}
	return &f, nil
}
