package sources

import (
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/raymondflorez/ray-research-tools/services/dataplane/entitle"
	"github.com/raymondflorez/ray-research-tools/services/dataplane/pit"
)

var tenorHeader = regexp.MustCompile(`^(\d+(?:\.\d+)?) (Mo|Month|Yr|Year)s?$`)

// tenor reads a column header such as "3 Mo" or "10 Yr" into "3M" or "10Y".
// An unrecognised header is an error: Treasury has added tenors over the
// years, and a column read by position rather than by name would put one
// tenor's yields under another's key.
func tenor(header string) (string, error) {
	m := tenorHeader.FindStringSubmatch(strings.TrimSpace(header))
	if m == nil {
		return "", fmt.Errorf("treasury: unrecognised column %q", header)
	}
	unit := "Y"
	if strings.HasPrefix(m[2], "Mo") {
		unit = "M"
	}
	return m[1] + unit, nil
}

// TreasuryParCurve reads Treasury's daily par yield curve CSV into facts
// `UST.par.<tenor>`, in percent as published, one per tenor per date.
//
// The file carries the curve as it stands today, not as first published, so
// there is one version per date, known from the start of the next New York
// day. A blank cell is a tenor not quoted that day and becomes no fact.
func TreasuryParCurve(body []byte) ([]pit.Fact, error) {
	r := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(body), "\xef\xbb\xbf")))
	r.FieldsPerRecord = -1
	rows, err := r.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("treasury: %w", err)
	}
	if len(rows) == 0 || strings.TrimSpace(rows[0][0]) != "Date" {
		return nil, fmt.Errorf("treasury: the first column is not Date")
	}
	tenors := make([]string, len(rows[0]))
	for i, h := range rows[0][1:] {
		t, err := tenor(h)
		if err != nil {
			return nil, err
		}
		tenors[i+1] = t
	}
	var out []pit.Fact
	for n, row := range rows[1:] {
		if len(row) != len(rows[0]) {
			return nil, fmt.Errorf("treasury: row %d has %d columns, the header %d", n+2, len(row), len(rows[0]))
		}
		date, err := time.Parse("01/02/2006", strings.TrimSpace(row[0]))
		if err != nil {
			return nil, fmt.Errorf("treasury: row %d: date %q", n+2, row[0])
		}
		day := date.Format("2006-01-02")
		known, _ := NextDayNewYork(day)
		for i, cell := range row[1:] {
			cell = strings.TrimSpace(cell)
			if cell == "" || cell == "N/A" {
				continue
			}
			v, err := strconv.ParseFloat(cell, 64)
			if err != nil {
				return nil, fmt.Errorf("treasury: row %d, %s: %q", n+2, rows[0][i+1], cell)
			}
			out = append(out, pit.Fact{
				Key: "UST.par." + tenors[i+1], ValidTime: day, KnowledgeTime: known, Value: v,
				Source: "US Treasury daily par yield curve", Class: entitle.Public,
			})
		}
	}
	return out, nil
}

// Treasury fetches the par yield curve, a calendar year at a time.
type Treasury struct {
	Client *http.Client
	Base   string
}

func (t Treasury) Year(ctx context.Context, year int) ([]pit.Fact, error) {
	base := t.Base
	if base == "" {
		base = "https://home.treasury.gov"
	}
	url := fmt.Sprintf("%s/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/%d/all?type=daily_treasury_yield_curve&field_tdr_date_value=%d&page&_format=csv", base, year, year)
	body, err := get(ctx, t.Client, url, map[string]string{"Accept": "text/csv"})
	if err != nil {
		return nil, err
	}
	return TreasuryParCurve(body)
}
