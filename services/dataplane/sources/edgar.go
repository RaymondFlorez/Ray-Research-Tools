package sources

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
)

// Period is which XBRL facts a field takes: a quarter's duration, a year's,
// or a balance at an instant.
type Period string

const (
	Quarter Period = "3M"
	Year    Period = "12M"
	Instant Period = "I"
)

// Concept maps one XBRL concept, in one unit and period, to a field name:
// `revenue=us-gaap:Revenues:USD:3M` reads quarterly revenue as `<TICKER>.revenue`.
type Concept struct {
	Field, Taxonomy, Name, Unit string
	Period                      Period
}

// ParseConcept reads `field=taxonomy:Name:unit:period`.
func ParseConcept(spec string) (Concept, error) {
	field, rest, ok := strings.Cut(spec, "=")
	parts := strings.Split(rest, ":")
	if !ok || field == "" || len(parts) != 4 {
		return Concept{}, fmt.Errorf("concept %q: want field=taxonomy:Name:unit:period", spec)
	}
	c := Concept{Field: field, Taxonomy: parts[0], Name: parts[1], Unit: parts[2], Period: Period(parts[3])}
	if c.Period != Quarter && c.Period != Year && c.Period != Instant {
		return Concept{}, fmt.Errorf("concept %q: period must be 3M, 12M or I", spec)
	}
	return c, nil
}

type companyFacts struct {
	CIK        json.Number `json:"cik"`
	EntityName string      `json:"entityName"`
	Facts      map[string]map[string]struct {
		Units map[string][]edgarValue `json:"units"`
	} `json:"facts"`
}

type edgarValue struct {
	Start string  `json:"start"`
	End   string  `json:"end"`
	Val   float64 `json:"val"`
	Accn  string  `json:"accn"`
	Form  string  `json:"form"`
	Filed string  `json:"filed"`
}

// Durations that count as a quarter and as a year. Fiscal calendars of 52 and
// 53 weeks make both vary by a week; a half-year or nine-month year-to-date
// figure falls in neither, and is not read as a quarter.
func periodMatches(p Period, v edgarValue) (bool, error) {
	if p == Instant {
		return v.Start == "", nil
	}
	if v.Start == "" {
		return false, nil
	}
	start, err := time.Parse("2006-01-02", v.Start)
	if err != nil {
		return false, fmt.Errorf("start %q: %w", v.Start, err)
	}
	end, err := time.Parse("2006-01-02", v.End)
	if err != nil {
		return false, fmt.Errorf("end %q: %w", v.End, err)
	}
	days := end.Sub(start).Hours() / 24
	if p == Quarter {
		return days >= 80 && days <= 100, nil
	}
	return days >= 350 && days <= 380, nil
}

// CompanyFacts turns an EDGAR company-facts document into facts for
// `instrument`, one series per concept.
//
// Valid time is the period's end; knowledge time is the day after the filing
// date (see NextDayNewYork). A filing repeats earlier periods as comparatives,
// so each period's versions are read in filing order and a later filing is a
// new version only when its value differs — a restatement, flagged — and not
// when it repeats what was already known.
//
// A concept the document does not have is an error: a typo'd concept name
// would otherwise load nothing and look like a company that reports nothing.
func CompanyFacts(body []byte, instrument string, concepts []Concept) ([]pit.Fact, error) {
	var doc companyFacts
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("company facts: %w", err)
	}
	var out []pit.Fact
	for _, c := range concepts {
		concept, ok := doc.Facts[c.Taxonomy][c.Name]
		if !ok {
			return nil, fmt.Errorf("%s has no %s:%s", doc.EntityName, c.Taxonomy, c.Name)
		}
		values, ok := concept.Units[c.Unit]
		if !ok {
			units := make([]string, 0, len(concept.Units))
			for u := range concept.Units {
				units = append(units, u)
			}
			sort.Strings(units)
			return nil, fmt.Errorf("%s:%s is not reported in %s (it is in %s)", c.Taxonomy, c.Name, c.Unit, strings.Join(units, ", "))
		}
		byEnd := map[string][]edgarValue{}
		for _, v := range values {
			match, err := periodMatches(c.Period, v)
			if err != nil {
				return nil, fmt.Errorf("%s:%s: %w", c.Taxonomy, c.Name, err)
			}
			if match {
				byEnd[v.End] = append(byEnd[v.End], v)
			}
		}
		ends := make([]string, 0, len(byEnd))
		for end := range byEnd {
			ends = append(ends, end)
		}
		sort.Strings(ends)
		key := instrument + "." + c.Field
		for _, end := range ends {
			versions := byEnd[end]
			sort.SliceStable(versions, func(i, j int) bool {
				if versions[i].Filed != versions[j].Filed {
					return versions[i].Filed < versions[j].Filed
				}
				return versions[i].Accn < versions[j].Accn
			})
			var last *float64
			for _, v := range versions {
				if last != nil && *last == v.Val {
					continue
				}
				known, err := NextDayNewYork(v.Filed)
				if err != nil {
					return nil, fmt.Errorf("%s:%s filed: %w", c.Taxonomy, c.Name, err)
				}
				out = append(out, pit.Fact{
					Key: key, ValidTime: end, KnowledgeTime: known, Value: v.Val,
					Source: strings.TrimSpace("SEC EDGAR " + v.Form + " " + v.Accn), Restatement: last != nil,
					Class: entitle.Public,
				})
				val := v.Val
				last = &val
			}
		}
	}
	return out, nil
}

// TickerCIKs reads the SEC's ticker file (company_tickers.json) into a map
// from ticker to CIK.
func TickerCIKs(body []byte) (map[string]int, error) {
	var doc map[string]struct {
		CIK    int    `json:"cik_str"`
		Ticker string `json:"ticker"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, fmt.Errorf("company tickers: %w", err)
	}
	out := make(map[string]int, len(doc))
	for _, e := range doc {
		out[strings.ToUpper(e.Ticker)] = e.CIK
	}
	return out, nil
}

// EDGAR fetches from the SEC. The SEC asks automated clients to name
// themselves in the User-Agent and to stay under ten requests a second; a
// client without a User-Agent is refused here rather than by the SEC.
type EDGAR struct {
	Client    *http.Client
	UserAgent string
	// Base URLs, overridable for tests.
	DataBase, WWWBase string
}

func (e EDGAR) base() (string, string) {
	data, www := e.DataBase, e.WWWBase
	if data == "" {
		data = "https://data.sec.gov"
	}
	if www == "" {
		www = "https://www.sec.gov"
	}
	return data, www
}

func (e EDGAR) headers() (map[string]string, error) {
	if strings.TrimSpace(e.UserAgent) == "" {
		return nil, fmt.Errorf("the SEC requires a User-Agent naming who is asking, such as \"Example Research admin@example.com\"")
	}
	return map[string]string{"User-Agent": e.UserAgent, "Accept": "application/json"}, nil
}

// CIK resolves a ticker through the SEC's ticker file.
func (e EDGAR) CIK(ctx context.Context, ticker string) (int, error) {
	h, err := e.headers()
	if err != nil {
		return 0, err
	}
	_, www := e.base()
	body, err := get(ctx, e.Client, www+"/files/company_tickers.json", h)
	if err != nil {
		return 0, err
	}
	ciks, err := TickerCIKs(body)
	if err != nil {
		return 0, err
	}
	cik, ok := ciks[strings.ToUpper(ticker)]
	if !ok {
		return 0, fmt.Errorf("the SEC's ticker file has no %s", ticker)
	}
	return cik, nil
}

// Facts fetches one company's facts and decodes them for `instrument`.
func (e EDGAR) Facts(ctx context.Context, cik int, instrument string, concepts []Concept) ([]pit.Fact, error) {
	h, err := e.headers()
	if err != nil {
		return nil, err
	}
	data, _ := e.base()
	body, err := get(ctx, e.Client, fmt.Sprintf("%s/api/xbrl/companyfacts/CIK%010d.json", data, cik), h)
	if err != nil {
		return nil, err
	}
	return CompanyFacts(body, instrument, concepts)
}
